# nhi-local

Experimental recipes and deliverables to run local MCP tools with authorized NHI
access to a data-fair platform.

`nhi-local` lets an agentic coding tool — [opencode](https://opencode.ai),
[Claude Code](https://claude.com/claude-code) — drive Playwright, curl, or any
HTTP client against a data-fair platform as a **non-human identity**, without a
long-lived secret ever entering the model's context.

## The problem

The usual alternative is pasting an API key or a session cookie into a tool
config or an environment variable. That credential is long-lived, usually
org-wide, and lands in the agent's context the moment the agent reads the
config, greps the repo, or echoes its environment — from where it reaches
transcripts, logs, and any page that manages a prompt injection.

simple-directory already provides the right primitive: a short-lived,
non-refreshable, org-scoped, individually revocable session obtained by
exchanging a signed assertion. `nhi-local` is the missing client half. It holds
the signing key, performs the exchange, and injects the resulting session into
ordinary local tools that know nothing about any of it.

```
playwright / curl ──▶ nhi-local proxy (127.0.0.1:7331) ──▶ https://koumoul.com
                          holds the key, rotates the session,
                          injects cookies, tunnels everything else
```

## Quickstart

```bash
npx @data-fair/nhi-local
```

That is the whole thing. With nothing configured it runs the setup wizard; once
a profile exists it starts the proxy.

```
$ npx @data-fair/nhi-local
Platform URL [https://koumoul.com]:
Profile name [koumoul.com]:
Subject (identifies this machine) [alban@thinkpad]:

Profile "koumoul.com" created at ~/.config/nhi-local/koumoul.com

Send this to an admin of your organization. Nothing in it is secret:

  ┌───────────────────────────────────────────────────────────────
  │ In https://koumoul.com, open your organization's page,
  │ then "Non-human identities" → add, and fill in:
  │
  │   issuer   https://nhi-local.data-fair.cloud/9f3c1a
  │   subject  alban@thinkpad
  │   jwks     {"keys":[{"kty":"EC",...}]}
  │
  │ Then send me back the generated id (it looks like nhi-XXXXXXXXXX).
  └───────────────────────────────────────────────────────────────

client_id: _
```

An org admin creates the NHI from those three values and returns the generated
id. Pressing `Ctrl-C` at the prompt is safe — the profile is already on disk, so
finish later with:

```bash
nhi-local enroll nhi-V1StGXR8Z5
```

`enroll` performs a real exchange immediately, so a misconfiguration surfaces
then rather than in the middle of an agent session.

**Deployment prerequisite:** the platform's simple-directory must run with
`manageNhis` enabled, or every exchange returns 404. `nhi-local` says so
explicitly when that happens.

## Profiles

One profile per platform. The filesystem is the list — a profile is any
directory under `~/.config/nhi-local/` containing a `config.json`, so `rm -r` on
one is a complete uninstall.

```bash
nhi-local profiles
# koumoul.com          https://koumoul.com          :7331   nhi-V1StGXR8Z5
# staging.koumoul.com  https://staging.koumoul.com  :7332   not enrolled
```

Profiles are named after the platform host. Ports auto-assign from 7331 upward.

**With one profile, `--profile` is never needed.** With more than one, every
command requires it and refuses to guess — a wrong guess would point one
organization's credential at another organization's platform.

```bash
nhi-local serve --profile staging.koumoul.com
```

## Wiring your tools

Start the proxy, which prints everything the recipes below need:

```bash
$ nhi-local serve
nhi-local proxying koumoul.com on http://127.0.0.1:7331
  profile   koumoul.com
  CA        ~/.config/nhi-local/koumoul.com/ca.crt
  SPKI pin  L8T9NCyb5ipq6Wjzg0pUpRRwKuiLUOje8a9e2YBw7lY=
Every other host is tunnelled untouched.
```

### curl

```bash
curl --proxy http://127.0.0.1:7331 \
     --cacert ~/.config/nhi-local/koumoul.com/ca.crt \
     https://koumoul.com/data-fair/api/v1/datasets
```

### Any Node-based tool

```bash
export HTTPS_PROXY=http://127.0.0.1:7331
export NODE_EXTRA_CA_CERTS=~/.config/nhi-local/koumoul.com/ca.crt
```

### Playwright MCP

Preferred form — pins one key rather than disabling certificate validation:

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

```bash
npx @playwright/mcp@latest --config ./playwright-mcp.json
```

The fallback is `--proxy-server=http://127.0.0.1:7331 --ignore-https-errors`.
**Know its cost:** it stops the browser validating certificates for *every* site
in that session, including the ones nhi-local tunnels and never touches. Prefer
the pin.

> **Why one pin covers every host.** Chromium's
> `--ignore-certificate-errors-spki-list` matches the **leaf** certificate's
> public key, not the CA's — verified directly against Chromium: pinning the CA's
> SPKI is rejected with `ERR_CERT_AUTHORITY_INVALID`, pinning the leaf's is
> accepted. nhi-local therefore mints every certificate from a *single reused
> leaf keypair*, so `nhi-local ca --spki` prints one stable value that works for
> every host the proxy ever presents.

### Two gotchas that fail silently

- **`no_proxy` normally contains `localhost`.** curl and most HTTP clients
  bypass a proxy for localhost, so a `http://localhost:5600` dev-stack target
  receives no injected cookies and merely looks logged out. Set `NO_PROXY=""`
  explicitly for that case.
- **Chromium also bypasses localhost.** Adjust `--proxy-bypass` when targeting a
  local dev stack.

## Keeping the key away from your agent

There is no cross-harness convention for this — Claude Code's own documentation
states that "there is no built-in credential deny list". Three tiers, in
increasing strength.

### Tier 1 — per-harness deny rules (advisory)

Claude Code, in `~/.claude/settings.json`:

```json
{ "permissions": { "deny": ["Read(~/.config/nhi-local/**)"] } }
```

In *user* settings a bare `Read(/foo/**)` resolves against `~/.claude`, so the
`~/` or `//` form is mandatory. A `Read` deny also blocks Edit and Write there.

opencode, in `~/.config/opencode/opencode.json` — last matching rule wins, so
the catch-all goes first:

```json
{ "permission": { "read": { "*": "allow", "~/.config/nhi-local/*": "deny" } } }
```

These are guardrails, not boundaries. Claude Code's docs name the holes: the
rules cover built-in file tools and bash commands it recognizes (`cat`, `head`,
`tail`, `sed`), but not `grep -r` run from a parent directory, and not a script
that opens the file itself.

### Tier 2 — Claude Code's sandbox (OS-enforced)

Purpose-built for this, and it closes Tier 1's holes because it applies to every
sandboxed Bash command *and its child processes*:

```json
{ "sandbox": { "credentials": { "files": [
  { "path": "~/.config/nhi-local", "mode": "deny" }
] } } }
```

Requires Claude Code v2.1.187+ with the sandbox enabled. A `deny` entry merges
across settings scopes and no scope can remove one another scope added. Limits:
Claude Code only, sandboxed commands only, and `sandbox.filesystem.disabled`
lifts it.

### Tier 3 — a separate OS user (recommended where it matters)

Run the daemon under its own uid with the key `0600` owned by it. The only tier
that holds regardless of which harness is running, including one nobody
configured.

```ini
# /etc/systemd/system/nhi-local.service
[Unit]
Description=nhi-local NHI credential proxy
After=network.target

[Service]
User=nhi-local
Group=nhi-local
Environment=XDG_CONFIG_HOME=/var/lib/nhi-local/.config
ExecStart=/usr/bin/npx @data-fair/nhi-local serve --profile koumoul.com
Restart=on-failure

[Install]
WantedBy=multi-user.target
```

### The caveat

> The key is the only *durable* secret. Hiding it means a leak cannot outlive the
> daemon or move to another machine. It does not mean a local agent cannot use
> the identity — anything running as your user can point at the proxy port and
> get authenticated traffic without ever touching the key. That is the intended
> behavior; the agent is meant to use the proxy.

## Troubleshooting

simple-directory answers **every** exchange failure with an identical
`401 invalid credentials`, deliberately, so it cannot be used as an oracle for
which check failed. `nhi-local` therefore diagnoses locally and tells you what
to check.

| What you see | What it means |
|---|---|
| `NHI support is not enabled on …` | The deployment has `manageNhis` false. An operator must enable it. |
| `Hit simple-directory's auth rate limit` | The limiter consumes a point on *every* exchange, keyed by IP and by client_id. Wait; if it recurs, an operator may need to raise `authRateLimit`. |
| `Local clock is 4m12s ahead of …` | Assertions live 120s, so drift alone rejects every exchange. Fix the system clock. |
| `Exchange rejected by … (same 401 for every cause)` | Work the printed checklist: client_id, site origin, JWKS still matching, NHI still present. |
| `nhi-local: …` in an HTTP 502 | A refresh failed mid-session. The proxy never forwards unauthenticated, so the cause is in the body. |

After rotating a key with `nhi-local setup --rotate`, re-print the JWKS for your
admin with `nhi-local status --jwks`. Inline JWKS has no refetch mechanism, so
the admin must update the binding by hand.

## Security model

- The credential never enters the agent's context, transcripts, or tool output.
- Sessions last at most 30 minutes and are non-refreshable by construction.
- The identity is scoped to exactly one organization, can never be an admin, and
  can never be an impersonation target.
- The proxy intercepts exactly one host. Every other CONNECT is tunnelled
  byte-for-byte, uninspected.
- Out of scope: a malicious process running as your own user. See the caveat
  above.

## Documentation

- [Design spec](docs/superpowers/specs/2026-09-10-nhi-local-design.md)
- [Implementation plan](docs/superpowers/plans/2026-09-10-nhi-local.md)
- [Contribution guidelines](CONTRIBUTING.md)

## License

AGPL-3.0-only
