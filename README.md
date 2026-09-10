# nhi-local

Run local MCP tools — Playwright, curl, any HTTP client — against a
[data-fair](https://github.com/data-fair) platform as a **non-human identity**,
without a long-lived secret ever entering your agent's context.

`nhi-local` holds an NHI signing key, exchanges it for short-lived
simple-directory sessions, and injects those sessions into ordinary local tools
through a proxy. The tools need no credentials of their own, and your agent —
[opencode](https://opencode.ai), [Claude Code](https://claude.com/claude-code) —
never sees one.

```
playwright / curl ──▶ nhi-local proxy (127.0.0.1:7331) ──▶ https://koumoul.com
                          holds the key, rotates the session,
                          injects cookies, tunnels everything else
```

## Getting started

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
id. `Ctrl-C` at the prompt is safe — the profile is already on disk, so finish
later with:

```bash
nhi-local enroll nhi-V1StGXR8Z5
```

`enroll` performs a real exchange immediately, so a misconfiguration surfaces
then rather than in the middle of an agent session.

Then start the proxy and point a tool at it:

```bash
$ nhi-local serve
nhi-local proxying koumoul.com on http://127.0.0.1:7331
  profile   koumoul.com
  CA        ~/.config/nhi-local/koumoul.com/ca.crt
  SPKI pin  L8T9NCyb5ipq6Wjzg0pUpRRwKuiLUOje8a9e2YBw7lY=
Every other host is tunnelled untouched.

$ curl --proxy http://127.0.0.1:7331 \
       --cacert ~/.config/nhi-local/koumoul.com/ca.crt \
       https://koumoul.com/data-fair/api/v1/datasets
```

[Wiring Playwright MCP and other tools →](docs/usage.md#wiring-your-tools)

Each NHI gets its own profile, so you can hold several on one platform —
`nhi-local setup --site https://koumoul.com --profile koumoul-readonly`. With
one profile, `--profile` is never needed.
[More on profiles →](docs/usage.md#profiles)

**Prerequisite:** the platform's simple-directory must run with `manageNhis`
enabled, or every exchange returns 404. `nhi-local` says so explicitly when that
happens.

## Documentation

- **[Usage guide](docs/usage.md)** — profiles, wiring each tool, troubleshooting
- **[Security](docs/security.md)** — threat model, and keeping the key away from
  your agent
- [Design spec](docs/superpowers/specs/2026-09-10-nhi-local-design.md)
- [Contributing](CONTRIBUTING.md)

## License

AGPL-3.0-only
