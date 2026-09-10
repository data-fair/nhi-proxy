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
PROFILE           PLATFORM                     SUBJECT                  PORT  NHI
koumoul-readonly  https://koumoul.com          readonly-agent@thinkpad  7332  nhi-8kQm2LpXsA
koumoul.com       https://koumoul.com          alban@thinkpad           7331  nhi-V1StGXR8Z5
staging           https://staging.koumoul.com  alban@thinkpad           7333  not enrolled
```

The first profile for a platform is named after its host. Each profile serves
its own identity from its own daemon, so run one `serve` per identity you want
live and point each tool at the matching port.

**Ports are suggested, then fixed.** `setup` proposes the next number from 7331
that no other profile claims and nothing on the machine is listening on; the
interactive wizard shows it so you can pick your own, and `--port` sets it
outright. Whatever you settle on is stored in the profile and never changes on
its own, because tool configs hard-code it.

That stability has one sharp edge worth knowing: **the numbers are reused**.
Delete a profile and the next one you create can inherit its port, so a tool
config left pointing there would then drive a different identity. If you delete
a profile whose port is referenced anywhere, either update those configs or
give the replacement an explicit `--port`.

### Adding a second NHI on the same platform

Name it yourself:

```bash
nhi-proxy setup --site https://koumoul.com \
                --profile koumoul-readonly \
                --subject readonly-agent@thinkpad
```

Give it a `--subject` too. It defaults to `<user>@<hostname>`, which is fine
for a first identity but leaves two of them looking alike in the admin's list —
and the subject is the label whoever approves the NHI actually sees. It is also
half of the `(issuer, subject)` pair the platform binds, so it is fixed at
creation: changing it later means an admin patches the binding.

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

### Moving or backing up a profile

A profile is just a directory, and nothing inside it records where it lives:

```bash
mkdir -p ~/.config/nhi-proxy
cp -a /path/to/old/nhi-proxy/koumoul.com ~/.config/nhi-proxy/
```

The issuer, subject, `client_id` and key all survive, so the NHI keeps working
with no admin involvement. The CA file is byte-identical too — which means the
**SPKI pin does not change**, and any Playwright config pinning it stays valid;
only a `--cacert` path pointing at the old location needs updating.

The same copy is your backup, and it is worth having: losing a profile means
losing the only key its NHI trusts, and the identity then has to be
re-registered by an admin.

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
  receives no injected cookies and merely looks logged out — a `200` with an
  anonymous body, which reads as a bug in nhi-proxy rather than a bypass. For
  curl, pass `--noproxy ''`; the flag beats the environment. Setting
  `NO_PROXY=""` is **not** enough, because curl reads the lowercase `no_proxy`
  first — clear both (`no_proxy= NO_PROXY= curl ...`) if you must use variables.
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
