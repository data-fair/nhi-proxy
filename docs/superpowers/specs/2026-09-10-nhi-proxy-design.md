# nhi-proxy — design

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

`nhi-proxy` is that client half.

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

An **ES256** (P-256 ECDSA) keypair generated at `setup`. Private key at
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

**CONNECT does not imply TLS, and the scheme does not imply the port.** Both
were found by running the end-to-end test against a real server, and both only
bite on the plain-http dev-stack path:

- Some clients — undici's `ProxyAgent` among them — tunnel *every* scheme
  through CONNECT. Meeting clear HTTP with a TLS handshake closes the socket
  with no diagnosable error, so the proxy hands an intercepted tunnel to a TLS
  server or a plain HTTP server according to the target's own scheme
  (`targetSecure`).
- The upstream port must come from the configured site (`targetPort`), not from
  the scheme's default. A target on `http://localhost:5690` is otherwise dialled
  at port 80.

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

`nhi-proxy setup` is a wizard, because this is a once-per-machine task done by
someone who has not read the source. On a TTY it prompts; with flags, or without
a TTY, it runs unattended so it stays scriptable and testable.

1. **Prompt** for the platform URL (default `https://koumoul.com`), the profile
   name (defaulted from the site host), and the subject (defaulted to
   `<user>@<hostname>`). Generate the keypair and CA.
2. **Print a delimited block to forward to an org admin** — the developer is
   frequently not the admin, so the output is written to be pasted into a chat
   message unedited. It carries the issuer, the subject, the public JWKS, and
   where in simple-directory they go.
3. **Wait for the pasted `client_id`** (`nhi-<nanoid>`) the admin returns, then
   perform a real test exchange and run the diagnostic checklist (§9) on
   failure.

Interrupting at step 3 is safe and expected: the profile is already on disk, and
the wizard says so, pointing at `nhi-proxy enroll <client_id>` to finish once
the admin replies. `enroll` therefore remains a first-class command, not merely
an internal step.

The same manual paste is used whether or not the developer is themselves an org
admin — one code path, and the human approval step stays explicit rather than
being automated away.

Rotating the key later is `setup --rotate` on an existing profile plus an admin
`PATCH` of the binding's JWKS. Inline JWKS has no refetch mechanism, so this is
necessarily a manual admin action.

## 7. Profiles, configuration and filesystem layout

### 7.1 Profiles

One directory per profile under `~/.config/nhi-proxy/` (XDG). Never inside a
project directory — that alone keeps it outside every project-scoped agent's
default file access, and out of git.

**The filesystem is the profile list.** A profile is any subdirectory holding a
`config.json`; there is no registry file to fall out of sync, and `rm -r` on the
directory is a complete uninstall of that profile.

**A profile is one NHI, not one platform.** Several NHIs on the same platform
is a normal setup — a read-only identity beside a writing one, one per
department, one per machine — and each needs its own signing key, issuer and
port, because each is a separate identity an admin can revoke on its own.

The first profile for a platform is **named after the site host** —
`koumoul.com`, `staging.koumoul.com`, `localhost-5600` — rather than a generic
`default`, which would be actively unhelpful the moment a second one exists.
`--profile` names any further one.

Re-running `setup --site <platform>` with the derived name already taken is
**refused**, not auto-suffixed: in a script that repetition is far more often a
mistake than an intention, and silently enrolling a second NHI would leave an
orphan identity behind. The interactive wizard offers a free name
(`koumoul.com-2`) as its prompt default instead, where a human confirms it.

**Resolution**, applied identically by every command:

| `--profile` | Profiles found | Behaviour |
|---|---|---|
| given | — | use it; if absent, error naming the profiles that do exist |
| absent | 0 | run `setup` |
| absent | 1 | use it implicitly |
| absent | 2+ | error listing them, asking for `--profile` |

The single-profile case is the common one and must not require ceremony; the
multi-profile case must never guess, because guessing means sending an
organization's credential at the wrong platform.

**Ports auto-assign at setup**: 7331, then the lowest free port above it not
already claimed in another profile's `config.json`. Each profile serves one
target from its own daemon, so two profiles must never collide by accident.

### 7.2 Layout and configuration

```
~/.config/nhi-proxy/
  koumoul.com/
    config.json
    key.jwk      0600   signing key
    ca.crt              local CA certificate
    ca.key       0600   local CA key
    leaf.key     0600   the single reused leaf keypair (see §8)
  staging.koumoul.com/
    ...
```

```json
{
  "site":     "https://koumoul.com",
  "sdPath":   "/simple-directory",
  "clientId": "nhi-V1StGXR8Z5",
  "issuer":   "https://nhi-proxy.data-fair.cloud/9f3c1a",
  "subject":  "alban@thinkpad",
  "port":     7331
}
```

`site` is both the audience and the host the proxy intercepts, and must be a
bare origin. `sdPath` is where simple-directory is mounted on that origin
(default `/simple-directory`; a data-fair stack serves the portal at `/` and
simple-directory under a prefix). Conflating the two is the most likely
configuration mistake and the reason they are separate fields — `setup` rejects
a `--site` carrying a path, since that is almost always someone pasting the
simple-directory URL.

The default issuer is `https://nhi-proxy.data-fair.cloud/<random>`, under a
domain the project controls. It never needs to resolve and must not serve a
discovery document. The random suffix is not a secret; it exists so two
developers' entries stay distinguishable in simple-directory's logs.

**One target per profile.** A developer working against both a local dev stack
and staging runs two daemons on two ports, as does one holding two NHIs on the
same platform. Multi-target routing inside one daemon is deliberately deferred.

**`--rotate` replaces the signing key and nothing else.** It resolves an
existing profile by the rules above and never creates one; it keeps the
`client_id`, issuer, platform, port and — critically — the local CA, since that
is the trust anchor already installed in every tool on the machine. Rotating it
would silently break all of them.

## 8. TLS interception and tool wiring

`setup` generates a CA and **one leaf keypair reused for every certificate the
proxy ever mints**. Leaves are minted per hostname on demand and cached in
memory. A single reused leaf key means a stable SubjectPublicKeyInfo across
every presented certificate, so there is exactly one fingerprint to pin —
printed by `nhi-proxy ca --spki`. This turns the browser recipe from "disable
certificate validation" into "trust this one key", a materially better posture
for a tool whose purpose is credential hygiene.

```bash
# curl
curl --proxy http://127.0.0.1:7331 \
     --cacert ~/.config/nhi-proxy/koumoul.com/ca.crt \
     https://koumoul.com/data-fair/api/v1/datasets

# any Node-based tool
export HTTPS_PROXY=http://127.0.0.1:7331
export NODE_EXTRA_CA_CERTS=~/.config/nhi-proxy/koumoul.com/ca.crt
```

Playwright MCP takes a config file rather than flags, because `--config` exposes
full `launchOptions` including Chromium `args` (verified against
`@playwright/mcp` 0.0.80):

```json
{
  "browser": {
    "launchOptions": {
      "proxy": { "server": "http://127.0.0.1:7331" },
      "args": ["--ignore-certificate-errors-spki-list=<nhi-proxy ca --spki>"]
    }
  }
}
```

`--ignore-https-errors` is documented as the one-line fallback, with its cost
stated: it stops the browser validating certificates for *every* site in that
session, including the ones nhi-proxy blind-tunnels and never touches.

**Resolved during implementation (2026-09-10).** Chromium's
`--ignore-certificate-errors-spki-list` matches the **leaf** certificate's SPKI
only, never the CA's. Tested directly against Chromium with a locally minted
chain: no pin and a CA-SPKI pin both fail with `ERR_CERT_AUTHORITY_INVALID`,
while the leaf-SPKI pin loads the page.

This promotes the reused-leaf-key decision from a convenience to a requirement:
minting a fresh leaf key per hostname would force a separate pin per host, and
the single-value recipe above would not exist. `ca --spki` prints the leaf
SPKI.

**Two gotchas that both fail silently and belong in the README:**

- **`no_proxy` normally contains `localhost`.** curl and most HTTP clients
  bypass a proxy for localhost, so a `http://localhost:5600` dev-stack target
  receives no injected cookies and merely looks logged out. Verified during
  implementation: `NO_PROXY=""` does **not** fix it, because curl reads the
  lowercase `no_proxy` first. The dev recipe uses curl's `--noproxy ''` flag,
  which beats the environment; clearing both variables also works.
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

**The local checklist on a 401** covers what nhi-proxy can see for itself:
`client_id` present and well-formed; `site` exactly as the admin configured it
(an origin mismatch is an audience mismatch); the binding's JWKS matching the
current key; and **clock skew, measured against the `Date` header of the very
response that just failed**. Skew is the nastiest cause — a two-minute assertion
lifetime turns modest drift into a permanent, undiagnosable 401 — and comparing
our clock to the server's costs one header read.

`enroll` runs a real exchange and this checklist at setup time, so
misconfiguration surfaces then rather than mid-agent-session.

**A failed refresh mid-session returns `502` from the proxy with a plain-text
body naming the nhi-proxy cause.** The request is *not* forwarded
unauthenticated: data-fair would answer with a 401 or a logged-out HTML page,
and an agent would burn tokens interpreting that instead of reading
`nhi-proxy: assertion rejected — local clock is 4m12s ahead of the server`.

## 10. Keeping the key away from the agent (documentation)

v1 ships this as README guidance only. nhi-proxy does not detect harnesses and
does not write to configuration files it does not own.

There is no cross-harness convention for this — Claude Code's documentation
states plainly that "there is no built-in credential deny list". Three tiers,
in increasing strength:

**Tier 1 — per-harness deny rules (advisory).**

Claude Code, in `~/.claude/settings.json`:

```json
{ "permissions": { "deny": ["Read(~/.config/nhi-proxy/**)"] } }
```

In *user* settings a bare `Read(/foo/**)` resolves against `~/.claude`, so the
`~/` or `//` form is mandatory. A `Read` deny also blocks Edit and Write on the
same path.

opencode, in `~/.config/opencode/opencode.json` (last matching rule wins, so the
catch-all goes first):

```json
{ "permission": { "read": { "*": "allow", "~/.config/nhi-proxy/*": "deny" } } }
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
  { "path": "~/.config/nhi-proxy", "mode": "deny" }
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

**Bare `nhi-proxy` is the whole user experience.** With no arguments it does the
next useful thing, so a first-time user who types the name and nothing else is
carried from setup to a running proxy:

| Profiles found | Bare `nhi-proxy` does |
|---|---|
| 0 | runs the `setup` wizard, then offers to start serving |
| 1 | serves it |
| 2+ | lists them and asks for `--profile` |

A single profile that was never enrolled is not a special case: `serve` fails
with the message that already exists for it — *not enrolled yet, run
`nhi-proxy enroll <client_id>`* — which points at the next step without adding
a branch.

| Command | Purpose |
|---|---|
| `setup [--site <origin>] [--profile <p>] [--subject <s>] [--sd-path <p>] [--port <n>] [--rotate]` | Configure a new profile: prompt (on a TTY) or take flags, generate keypair and CA, print the block for the admin, then wait for a `client_id`. `--site` defaults to `https://koumoul.com`, `--subject` to `<user>@<hostname>`, `--profile` to the site host |
| `enroll <client_id>` | Record the client_id, run a test exchange and the diagnostic checklist |
| `serve [--port <n>]` | Run the proxy |
| `status [--jwks]` | Binding, session expiry, last exchange result; `--jwks` re-prints the public JWKS for a re-paste after rotation |
| `ca [--spki]` | Print the CA path, or the pin value for tool wiring |
| `profiles` | List configured profiles with their site and port |

Every command except `profiles` takes `--profile <p>` and follows the resolution
table in §7.1. `setup` is the exception that *creates* rather than resolves:
without `--profile` it derives the name from the site host, and it refuses to
overwrite an existing profile unless `--rotate` is given.

`setup` prompts only when stdin is a TTY. Without one it runs from flags alone
and skips the wait for a `client_id`, so it works in a script and in tests.

Published as `@data-fair/nhi-proxy`, Node and TypeScript, matching the rest of
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

**End to end, self-contained.** `npm run e2e` brings up an isolated
simple-directory via `docker-compose.yml` (its own compose project, tmpfs mongo,
unusual ports), seeds an organization and an admin of it, creates an NHI
carrying nhi-proxy's real JWKS, starts the proxy, and asserts that a request
through it comes back identifying the NHI with `nhi: 1` and no admin flag. This
is the only test that proves the whole chain, and it must stay runnable without
manual setup — it is what caught both proxy bugs above.

Four things that stack needs, none of them obvious: `MANAGE_NHIS=true`; a
`PUBLIC_URL` carrying the `/simple-directory` path; an nginx supplying
`X-Forwarded-Host`/`-Proto`/`-For`, with the port preserved because the origin
it yields *is* the audience; and a raised `AUTHRATELIMIT_ATTEMPTS`, since the
limiter spends a point per exchange and the default of 5/minute is exhausted by
a couple of runs. The published release tags predate the NHI feature, so the
image is `:master`.

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
   *public* JWKS that `setup` prints for the admin.
2. The proxy intercepts exactly one host, the configured `site`. Every other
   CONNECT is tunnelled without inspection.
3. Session cookies live in memory only and are never persisted.
4. A refresh failure produces an explicit `502` naming the cause. A request is
   never forwarded unauthenticated as a fallback.
5. Concurrent requests needing a refresh trigger exactly one exchange.
6. `key.jwk`, `ca.key`, and `leaf.key` are created 0600 in a 0700 directory,
   outside any project tree.
7. With more than one profile configured and no `--profile` given, no command
   ever picks one. Guessing here means acting as a different identity — a
   different NHI on the same platform, or another organization entirely.
8. `setup` never silently enrols a second NHI: a name collision is an error,
   and `--rotate` never creates a profile.
