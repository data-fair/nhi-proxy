# nhi-local — design

A local credential provider that lets an agentic coding harness (opencode, Claude
Code) drive local MCP tools — Playwright, curl, any HTTP client — against a
data-fair platform as a **non-human identity**, without a long-lived secret ever
entering the model's context.

Status: design approved 2026-09-10, not yet implemented. v1 scope.

## 1. Why this exists

The alternative today is pasting an API key or a session cookie into a tool
config or an environment variable. That credential is long-lived, usually
org-wide, and lands in the agent's context the moment the agent reads the
config, greps the repo, or echoes its environment — from where it reaches
transcripts, logs, and any page that manages a prompt injection.

simple-directory's NHI feature already provides the right primitive: a short,
non-refreshable, org-scoped, individually revocable session obtained by
exchanging a signed assertion. What is missing is the client half — something
that holds the signing key, performs the exchange, and hands the resulting
session to ordinary local tools that know nothing about any of it.

`nhi-local` is that client half.

## 2. Constraints inherited from simple-directory

Everything below was verified against `~/data-fair/simple-directory` at design
time. See `docs/architecture/non-human-identities.md` there for the full model.

**The server cannot reach a laptop, so the provider must use inline JWKS.**
`getKeyResolver` (`api/src/nhis/keys.ts`) returns `createLocalJWKSet` and skips
discovery entirely when `nhi.provider.jwks` is present. This is the documented
"private-cluster answer" and it is the only viable path for a local provider.

**The issuer must still be a syntactically valid https URL with a non-private
host, but it need not resolve.** `checkProvider` calls `assertSafeIssuer`
unconditionally at create/patch time, so `http://` and `localhost` are rejected;
but with an inline JWKS nothing is ever fetched from it. Confirmed by
`tests/features/nhis.api.spec.ts`, which rejects an unreachable issuer only in
the discovery case (no inline `jwks`).

**Audience is the site origin, not the simple-directory URL.** The exchange
passes `reqSiteUrl(req)` as `audience`, and
`reqSiteUrl = reqOrigin(req) + reqSitePath(req)`
(`@data-fair/lib-express/site.js`). The NHI test states it directly:
"expected audience is the site origin, i.e. directoryUrl without the
/simple-directory suffix". This is why the config carries the site origin and
the simple-directory mount path as two separate values (§7).

**Required assertion claims are `exp`, `sub`, `iat`**, plus `iss` and `aud`
matched by `jwtVerify` (`verifyAssertion`, `api/src/nhis/service.ts`).

**The data-fair stack authenticates by cookie only.** `readStateFromCookie`
(`@data-fair/lib-node/session.js`) is the sole session path; there is no
`Authorization: Bearer` branch anywhere in lib-express or lib-node. The JWT
arrives split across cookies — `id_token` = `header.payload`, `id_token_sign` =
signature — plus `id_token_org`, and `id_token_dep` / `id_token_role` when
applicable. Injecting a Bearer header would silently do nothing. **The proxy
must inject cookies.**

**Sessions are capped and non-refreshable by construction.** `exp` is
`min(assertion.exp, now + jwtDurations.nhiToken)`, default 30 minutes;
`skipExchangeToken: true` means no exchange token and no server session exists,
so no code path can renew one. A new session requires a new exchange.
`keepalive` on an NHI session is an explicit no-op — it neither renews nor logs
out — so a browser hitting a data-fair SPA will not destroy the session it was
just given.

**Every exchange failure returns an identical `401 invalid credentials`** with a
random 0–1000ms delay, through a single `reject()` helper, deliberately to deny
an attacker an oracle on which check failed. Correct for the server; it means
**all diagnosis must happen client-side** (§9).

**The rate limiter consumes a point on success, not only on failure**, keyed by
both caller IP and `client_id`. Refreshing more often than necessary is actively
costly, which shapes the rotation strategy (§5).

## 3. Threat model

**In scope — the realistic failure mode:**

- No credential ever enters the model's context, transcripts, or tool output.
- Sessions last at most 30 minutes and cannot be refreshed.
- The identity is scoped to exactly one organization, can never be `isAdmin`,
  and can never be an `asAdmin` impersonation target (enforced at both the
  storage and token layers in simple-directory).
- One NHI per developer per machine, revocable individually by an org admin
  without disturbing anyone else.

**Out of scope, and documented as such:** a malicious process running as the
developer's own user. It can read the signing key, and — more to the point —
it can simply use the proxy on `127.0.0.1` and get authenticated traffic without
ever touching the key. §10 covers what can be done cheaply anyway and states
this limit plainly rather than implying protection that is not there.

## 4. Architecture

One process, three parts.

### 4.1 Signer

An **ES256** (P-256 ECDSA) keypair generated at `init`. Private key at
`key.jwk`, mode 0600; the public half is published to simple-directory as the
binding's inline JWKS, as `{ kty: 'EC', crv: 'P-256', alg: 'ES256', use: 'sig',
kid, x, y }`.

ES256 rather than Ed25519 for a verified interop reason: simple-directory runs
`jose` 4.15.9, where an Ed25519 key must be signed with `alg: 'EdDSA'`, while
jose 5 and 6 also accept `alg: 'Ed25519'`. A newer client signing with the newer
name against an older deployment fails with the endpoint's uniform 401 and no
way to tell why. ES256 is spelled identically across every jose major, and is
compact. RS256 (what simple-directory's own NHI tests use) would also be safe;
ES256 is preferred for key size.

Mints one assertion per exchange:

```
{ iss: <configured issuer>,
  sub: <configured subject>,
  aud: <site origin>,
  iat: now,
  exp: now + 120,
  jti: <random> }
```

A two-minute lifetime bounds replay of a captured assertion to two minutes
rather than the session's full thirty. `jti` is included for the issuer's own
logs; simple-directory does not track it (no replay protection beyond `exp` is
inherent to RFC 7523 bearer exchange, and is documented as accepted upstream).

### 4.2 Session holder

`POST <site><sdPath>/api/auth/nhi-token` with `{ client_id, assertion }`, then
**stores the response's `Set-Cookie` headers verbatim**.

Storing the cookies rather than the body's `access_token` is deliberate: it
avoids reimplementing the `header.payload` / `signature` split, avoids guessing
`id_token_org` / `id_token_dep` / `id_token_role`, and stays correct if
simple-directory changes the cookie shape. Expiry comes from `expires_in` in the
response body. Cookies live in memory only — they are re-obtainable at any time
and writing them to disk would create a second durable secret for no gain.

### 4.3 Proxy

An HTTP CONNECT proxy bound to `127.0.0.1:<port>`.

- `CONNECT <target-host>:443` → terminated with a certificate minted by the
  local CA, request inspected, cookies injected, forwarded upstream over a
  normal verified TLS connection.
- **Every other CONNECT is blind-tunnelled byte for byte.** No certificate is
  minted, no bytes are inspected. An agent browsing GitHub or npm passes through
  untouched — which matters for the security story and also avoids breaking
  certificate-pinned sites for no benefit.
- Plain-HTTP requests to the target (localhost dev stacks) take the same
  injection path with no TLS work.

Injection merges the held cookies into any `Cookie` header already present
rather than replacing it, so a tool that sets its own unrelated cookies keeps
them.

## 5. Token lifecycle

Lazy, with a margin:

- On the first request after startup there is no session at all: exchange then,
  not at boot. Starting the daemon must not require the network to be up or the
  binding to be live yet.
- Refresh when the held session has under 5 minutes left.
- Refresh once on a `401` from upstream to a request we believed was
  authenticated, then surface the failure rather than looping.
- No background timer. The daemon may idle for hours between agent sessions,
  and every successful exchange consumes a rate-limiter point.

At a 30-minute cap this is roughly two exchanges per hour of active use.

**Refreshes are deduplicated behind a single in-flight promise.** A Playwright
page issuing twenty parallel requests must trigger one exchange, not twenty —
otherwise the rate limiter trips on ordinary use.

## 6. Enrollment

No changes to simple-directory are required; its add-NHI form already accepts a
pasted inline JWKS (`ui/src/components/add-nhi-menu.vue`).

1. `nhi-local init --site https://site.example.com --subject alban@thinkpad`
   generates the keypair and CA, writes the config, and prints the three values
   the org admin needs: **issuer**, **subject**, **public JWKS**.
2. An org admin creates the NHI with those values (name, role, optional
   department are theirs to choose) and returns the generated `client_id`
   (`nhi-<nanoid>`).
3. `nhi-local enroll nhi-V1StGXR8Z5` records it and immediately performs a real
   test exchange, running the full diagnostic checklist (§9) on failure.

The human-admin approval step stays explicit and is not automated away. Rotating
the key later is `init --rotate` plus an admin `PATCH` of the binding's JWKS —
inline JWKS has no refetch mechanism, so this is necessarily a manual admin
action.

## 7. Configuration and filesystem layout

`~/.config/nhi-local/<profile>/` (XDG; `default` when unnamed). Never inside a
project directory — that alone keeps it outside every project-scoped agent's
default file access, and out of git.

```
config.json
key.jwk      0600   signing key
ca.crt              local CA certificate
ca.key       0600   local CA key
leaf.key     0600   the single reused leaf keypair (see §8)
```

```json
{
  "site":     "https://site.example.com",
  "sdPath":   "/simple-directory",
  "clientId": "nhi-V1StGXR8Z5",
  "issuer":   "https://nhi-local.data-fair.cloud/9f3c1a",
  "subject":  "alban@thinkpad",
  "port":     7331
}
```

`site` is both the audience and the host the proxy intercepts. `sdPath` is where
simple-directory is mounted on that origin (default `/simple-directory`; a
data-fair stack serves the portal at `/` and simple-directory under a prefix).
Conflating the two is the most likely configuration mistake and the reason they
are separate fields.

The default issuer is `https://nhi-local.data-fair.cloud/<random>`, under a
domain the project controls. It never needs to resolve and must not serve a
discovery document. The random suffix is not a secret; it exists so two
developers' entries stay distinguishable in simple-directory's logs.

**One target per profile.** A developer working against both a local dev stack
and staging runs two daemons on two ports. Multi-target routing in one daemon is
deliberately deferred.

## 8. TLS interception and tool wiring

`init` generates a CA and **one leaf keypair reused for every certificate the
proxy ever mints**. Leaves are minted per hostname on demand and cached in
memory. A single reused leaf key means a stable SubjectPublicKeyInfo across
every presented certificate, so there is exactly one fingerprint to pin —
printed by `nhi-local ca --spki`. This turns the browser recipe from "disable
certificate validation" into "trust this one key", a materially better posture
for a tool whose purpose is credential hygiene.

```bash
# curl
curl --proxy http://127.0.0.1:7331 \
     --cacert ~/.config/nhi-local/default/ca.crt \
     https://site.example.com/api/v1/datasets

# any Node-based tool
export HTTPS_PROXY=http://127.0.0.1:7331
export NODE_EXTRA_CA_CERTS=~/.config/nhi-local/default/ca.crt
```

Playwright MCP takes a config file rather than flags, because `--config` exposes
full `launchOptions` including Chromium `args` (verified against
`@playwright/mcp` 0.0.80):

```json
{
  "browser": {
    "launchOptions": {
      "proxy": { "server": "http://127.0.0.1:7331" },
      "args": ["--ignore-certificate-errors-spki-list=<nhi-local ca --spki>"]
    }
  }
}
```

`--ignore-https-errors` is documented as the one-line fallback, with its cost
stated: it stops the browser validating certificates for *every* site in that
session, including the ones nhi-local blind-tunnels and never touches.

**Implementation note.** Chromium's `--ignore-certificate-errors-spki-list`
matches SPKI hashes against certificates in the chain. Verify during
implementation whether it matches the CA's SPKI or only the leaf's. If only the
leaf's, the single reused leaf key already makes one pin sufficient — pin the
leaf's SPKI instead of the CA's. Either way one stable value works; this note
only decides which one `ca --spki` prints.

**Two gotchas that both fail silently and belong in the README:**

- **`no_proxy` normally contains `localhost`.** curl and most HTTP clients
  bypass a proxy for localhost, so a `http://localhost:5600` dev-stack target
  receives no injected cookies and merely looks logged out. The dev recipe must
  set `NO_PROXY=""` explicitly.
- **Chromium also bypasses localhost** unless told otherwise; the dev recipe
  needs `--proxy-bypass` adjusted accordingly.

## 9. Failure handling and diagnostics

simple-directory answers every exchange failure with an identical `401`. Three
responses are nonetheless distinguishable and must be named outright:

| Response | Cause | Message |
|---|---|---|
| `404` | `config.manageNhis` is false | NHI support is not enabled on this deployment; an operator must enable it |
| `429` | rate limiter tripped (per IP or per client_id) | back off and say so; never retry-storm |
| `401` | everything else | run the local checklist |

**The local checklist on a 401** covers what nhi-local can see for itself:
`client_id` present and well-formed; `site` exactly as the admin configured it
(an origin mismatch is an audience mismatch); the binding's JWKS matching the
current key; and **clock skew, measured against the `Date` header of the very
response that just failed**. Skew is the nastiest cause — a two-minute assertion
lifetime turns modest drift into a permanent, undiagnosable 401 — and comparing
our clock to the server's costs one header read.

`enroll` runs a real exchange and this checklist at setup time, so
misconfiguration surfaces then rather than mid-agent-session.

**A failed refresh mid-session returns `502` from the proxy with a plain-text
body naming the nhi-local cause.** The request is *not* forwarded
unauthenticated: data-fair would answer with a 401 or a logged-out HTML page,
and an agent would burn tokens interpreting that instead of reading
`nhi-local: assertion rejected — local clock is 4m12s ahead of the server`.

## 10. Keeping the key away from the agent (documentation)

v1 ships this as README guidance only. nhi-local does not detect harnesses and
does not write to configuration files it does not own.

There is no cross-harness convention for this — Claude Code's documentation
states plainly that "there is no built-in credential deny list". Three tiers,
in increasing strength:

**Tier 1 — per-harness deny rules (advisory).**

Claude Code, in `~/.claude/settings.json`:

```json
{ "permissions": { "deny": ["Read(~/.config/nhi-local/**)"] } }
```

In *user* settings a bare `Read(/foo/**)` resolves against `~/.claude`, so the
`~/` or `//` form is mandatory. A `Read` deny also blocks Edit and Write on the
same path.

opencode, in `~/.config/opencode/opencode.json` (last matching rule wins, so the
catch-all goes first):

```json
{ "permission": { "read": { "*": "allow", "~/.config/nhi-local/*": "deny" } } }
```

These are guardrails, not boundaries. Claude Code's own docs name the holes:
the rules cover built-in file tools and bash commands it recognizes (`cat`,
`head`, `tail`, `sed`), but not `grep -r` run from a parent directory, and not a
script that opens the file itself.

**Tier 2 — Claude Code's sandbox (OS-enforced).** Purpose-built for this, and
it closes Tier 1's holes because it applies to every sandboxed Bash command and
its child processes:

```json
{ "sandbox": { "credentials": { "files": [
  { "path": "~/.config/nhi-local", "mode": "deny" }
] } } }
```

Requires Claude Code v2.1.187+ and the sandbox enabled. A `deny` entry merges
across settings scopes and no scope can remove one another scope added. Limits:
Claude Code only, sandboxed commands only, and `sandbox.filesystem.disabled`
lifts it.

**Tier 3 — a separate OS user (recommended where it matters).** The daemon runs
under its own uid with the key 0600 owned by it. The only tier that holds
regardless of which harness is running, including one nobody configured. Ships
as a documented systemd unit.

**The caveat that must appear in the README, not be implied away:**

> The key is the only *durable* secret. Hiding it means a leak cannot outlive
> the daemon or move to another machine. It does not mean a local agent cannot
> use the identity — anything running as your user can point at the proxy port
> and get authenticated traffic without ever touching the key. That is the
> intended behavior; the agent is meant to use the proxy.

## 11. CLI surface

| Command | Purpose |
|---|---|
| `init --site <url> [--subject <s>] [--rotate]` | Generate keypair and CA, write config, print issuer / subject / JWKS for the admin. `--subject` defaults to `<user>@<hostname>` |
| `enroll <client_id>` | Record the client_id, run a test exchange and the diagnostic checklist |
| `serve [--port <n>]` | Run the proxy |
| `status` | Binding, session expiry, last exchange result |
| `ca --spki` / `ca --path` | Print the pin value / the CA path for tool wiring |

Every command takes `--profile <p>` (default `default`), selecting the directory
under `~/.config/nhi-local/`.

Published as `@data-fair/nhi-local`, Node and TypeScript, matching the rest of
the stack. Runnable via `npx`.

## 12. Testing

**Unit.** Assertion claim shape against exactly what `verifyAssertion` requires;
cookie merging (including preserving unrelated cookies already on the request);
CONNECT routing — target host intercepted, every other host tunnelled verbatim;
the refresh-margin and in-flight-dedup logic.

**Proxy integration.** Against a local HTTPS server: the presented chain
validates against the generated CA, the SPKI is stable across hostnames, and
cookies are injected on the target while a tunnelled host passes through
unmodified.

**End to end.** Against simple-directory's dev stack with `manageNhis` enabled:
create an NHI carrying nhi-local's real JWKS, start the proxy, make a request
through it, assert an authenticated response. This is the only test that proves
the whole chain. `tests/features/nhis.api.spec.ts` and `dev/fixtures.ts` in
simple-directory give the pattern.

**Diagnostics.** The 404 / 429 / 401 branches and the clock-skew detector are
worth direct tests — they are the parts a user meets on a bad day, and the
server gives them nothing to work with.

## 13. Out of scope for v1

- Multi-target routing in a single daemon (run one daemon per target).
- Automated enrollment, whether by self-enroll with an admin session or by a
  prefilled deep link into simple-directory's UI.
- Any change to simple-directory. v1 works against a deployed instance as-is.
- OS keychain or passphrase-protected key storage (see §3 — a compromised local
  user is out of scope, and the open proxy port bounds the value anyway).
- Request policy at the proxy: audit logging, read-only mode, per-path
  restrictions. Worth revisiting once the credential path is proven.
- A `harden` subcommand that writes harness configs. Documented instead (§10).
- Docker distribution.

## 14. Invariants

1. No credential — signing key, assertion, session cookie — is ever written to
   stdout, to a log line, or to any response body a tool can read, except the
   *public* JWKS that `init` prints for the admin.
2. The proxy intercepts exactly one host, the configured `site`. Every other
   CONNECT is tunnelled without inspection.
3. Session cookies live in memory only and are never persisted.
4. A refresh failure produces an explicit `502` naming the cause. A request is
   never forwarded unauthenticated as a fallback.
5. Concurrent requests needing a refresh trigger exactly one exchange.
6. `key.jwk`, `ca.key`, and `leaf.key` are created 0600 in a 0700 directory,
   outside any project tree.
