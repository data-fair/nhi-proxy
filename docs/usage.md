# Using nhi-proxy

Everything beyond [getting started](../README.md): profiles, wiring each tool,
and what to do when something fails.

## Profiles

**One profile is one NHI.** Several NHIs on the same platform is a normal
setup — a read-only identity alongside a writing one, one per department, one
per machine — and each gets its own profile, its own signing key, its own
issuer and its own port.

The filesystem is the list: a profile is any directory under
`~/.config/nhi-proxy/` containing a `config.json`, so `rm -r` on one is a
complete uninstall.

```bash
$ nhi-proxy profiles
PROFILE           PLATFORM              SUBJECT         PORT  NHI
koumoul-readonly  https://koumoul.com   alban@thinkpad  7332  nhi-8kQm2LpXsA
koumoul.com       https://koumoul.com   alban@thinkpad  7331  nhi-V1StGXR8Z5
staging           https://staging.koumoul.com  alban@thinkpad  7333  not enrolled
```

The first profile for a platform is named after its host; ports auto-assign
from 7331 upward.

### Adding a second NHI on the same platform

Name it yourself:

```bash
nhi-proxy setup --site https://koumoul.com --profile koumoul-readonly
```

Re-running `setup --site <platform>` without `--profile` is refused rather than
quietly enrolling a second NHI, since that is far more often a mistake than an
intention. The interactive wizard instead offers a free name (`koumoul.com-2`)
for you to accept or replace.

### Choosing a profile

**With one profile, `--profile` is never needed.** With more than one, every
command requires it and refuses to guess — a wrong guess would act as a
different identity, possibly in a different organization.

```bash
nhi-proxy serve --profile koumoul-readonly
```

### Rotating a key

```bash
nhi-proxy setup --rotate --profile koumoul-readonly
```

This replaces the signing key and leaves everything else alone: the same
`client_id`, issuer, platform and port, and the same local CA — so every tool
you have already wired keeps working. Give the admin the new JWKS
(`nhi-proxy status --jwks`) to paste onto the existing NHI. `--rotate` never
creates a profile.

## Wiring your tools

Start the proxy, which prints everything the recipes below need:

```bash
$ nhi-proxy serve
nhi-proxy proxying koumoul.com on http://127.0.0.1:7331
  profile   koumoul.com
  CA        ~/.config/nhi-proxy/koumoul.com/ca.crt
  SPKI pin  L8T9NCyb5ipq6Wjzg0pUpRRwKuiLUOje8a9e2YBw7lY=
Every other host is tunnelled untouched.
```

### curl

```bash
curl --proxy http://127.0.0.1:7331 \
     --cacert ~/.config/nhi-proxy/koumoul.com/ca.crt \
     https://koumoul.com/data-fair/api/v1/datasets
```

### Any Node-based tool

```bash
export HTTPS_PROXY=http://127.0.0.1:7331
export NODE_EXTRA_CA_CERTS=~/.config/nhi-proxy/koumoul.com/ca.crt
```

### Playwright MCP

Preferred form — pins one key rather than disabling certificate validation:

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

```bash
npx @playwright/mcp@latest --config ./playwright-mcp.json
```

The fallback is `--proxy-server=http://127.0.0.1:7331 --ignore-https-errors`.
**Know its cost:** it stops the browser validating certificates for *every* site
in that session, including the ones nhi-proxy tunnels and never touches. Prefer
the pin.

> **Why one pin covers every host.** Chromium's
> `--ignore-certificate-errors-spki-list` matches the **leaf** certificate's
> public key, not the CA's — verified directly against Chromium: pinning the CA's
> SPKI is rejected with `ERR_CERT_AUTHORITY_INVALID`, pinning the leaf's is
> accepted. nhi-proxy therefore mints every certificate from a *single reused
> leaf keypair*, so `nhi-proxy ca --spki` prints one stable value that works for
> every host the proxy ever presents.

### Two gotchas that fail silently

- **`no_proxy` normally contains `localhost`.** curl and most HTTP clients
  bypass a proxy for localhost, so a `http://localhost:5600` dev-stack target
  receives no injected cookies and merely looks logged out. Set `NO_PROXY=""`
  explicitly for that case.
- **Chromium also bypasses localhost.** Adjust `--proxy-bypass` when targeting a
  local dev stack.

## Troubleshooting

simple-directory answers **every** exchange failure with an identical
`401 invalid credentials`, deliberately, so it cannot be used as an oracle for
which check failed. `nhi-proxy` therefore diagnoses locally and tells you what
to check.

| What you see | What it means |
|---|---|
| `NHI support is not enabled on …` | The deployment has `manageNhis` false. An operator must enable it. |
| `Hit simple-directory's auth rate limit` | The limiter consumes a point on *every* exchange, keyed by IP and by client_id. Wait; if it recurs, an operator may need to raise `authRateLimit`. |
| `Local clock is 4m12s ahead of …` | Assertions live 120s, so drift alone rejects every exchange. Fix the system clock. |
| `Exchange rejected by … (same 401 for every cause)` | Work the printed checklist: client_id, site origin, JWKS still matching, NHI still present. |
| `nhi-proxy: …` in an HTTP 502 | A refresh failed mid-session. The proxy never forwards unauthenticated, so the cause is in the body. |

After rotating a key with `nhi-proxy setup --rotate`, re-print the JWKS for your
admin with `nhi-proxy status --jwks`. Inline JWKS has no refetch mechanism, so
the admin must update the binding by hand.

## See also

- [Security and key protection](security.md)
- [Design spec](superpowers/specs/2026-09-10-nhi-proxy-design.md)
