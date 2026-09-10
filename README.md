# nhi-proxy

Run local MCP tools — Playwright, curl, any HTTP client — against a
[data-fair](https://github.com/data-fair) platform as a **non-human identity**,
without a long-lived secret ever entering your agent's context.

`nhi-proxy` holds an NHI signing key, exchanges it for short-lived
simple-directory sessions, and injects those sessions into ordinary local tools
through a local proxy. The tools need no credentials of their own, and your
agent — [opencode](https://opencode.ai),
[Claude Code](https://claude.com/claude-code) — never sees one.

**One identity, one profile.** A profile holds one NHI: its own key, its own
issuer, its own proxy port. Keep as many as you have identities — a read-only
agent beside a writing one, one per project, one per platform — and pick
between them with `--profile`.

```
playwright / curl ──▶ nhi-proxy :7331 ──▶ https://koumoul.com   (writing agent)
                  ──▶ nhi-proxy :7332 ──▶ https://koumoul.com   (read-only agent)
                          each holds one identity's key, rotates its
                          session, injects cookies, tunnels everything else
```

## Getting started

```bash
npx @data-fair/nhi-proxy
```

That is the whole thing. With nothing configured it sets up your first
identity; once one exists it starts the proxy.

```
$ npx @data-fair/nhi-proxy
Platform URL [https://koumoul.com]:
Name for this identity [koumoul.com]:
Subject (how the platform's admin will recognise it) [alban@thinkpad]:

Profile "koumoul.com" created at ~/.config/nhi-proxy/koumoul.com

Send this to an admin of your organization. Nothing in it is secret:

  ┌───────────────────────────────────────────────────────────────
  │ In https://koumoul.com, open your organization's page,
  │ then "Non-human identities" → add, and fill in:
  │
  │   issuer   https://nhi-proxy.data-fair.cloud/9f3c1a
  │   subject  alban@thinkpad
  │   jwks     {"keys":[{"kty":"EC",...}]}
  │
  │ Then send me back the generated id (it looks like nhi-XXXXXXXXXX).
  └───────────────────────────────────────────────────────────────

client_id: _
```

The name defaults to the platform's host, which is all you need for a first
identity — name later ones for what they *do*, not where they live.

An org admin creates the NHI from those three values and returns the generated
id. `Ctrl-C` at the prompt is safe — the profile is already on disk, so finish
later with:

```bash
nhi-proxy enroll nhi-V1StGXR8Z5
```

`enroll` performs a real exchange immediately, so a misconfiguration surfaces
then rather than in the middle of an agent session.

Then start the proxy and point a tool at it:

```bash
$ nhi-proxy serve
nhi-proxy proxying koumoul.com on http://127.0.0.1:7331
  profile   koumoul.com
  CA        ~/.config/nhi-proxy/koumoul.com/ca.crt
  SPKI pin  L8T9NCyb5ipq6Wjzg0pUpRRwKuiLUOje8a9e2YBw7lY=
Every other host is tunnelled untouched.

$ curl --proxy http://127.0.0.1:7331 \
       --cacert ~/.config/nhi-proxy/koumoul.com/ca.crt \
       https://koumoul.com/data-fair/api/v1/datasets
```

[Wiring Playwright MCP and other tools →](docs/usage.md#wiring-your-tools)

## More than one identity

Give each its own name. The platform can be the same one:

```bash
nhi-proxy setup --site https://koumoul.com \
                --profile readonly-agent \
                --subject readonly-agent@thinkpad
nhi-proxy profiles
```

```
PROFILE         PLATFORM             SUBJECT                  PORT  NHI
koumoul.com     https://koumoul.com  alban@thinkpad           7331  nhi-V1StGXR8Z5
readonly-agent  https://koumoul.com  readonly-agent@thinkpad  7332  nhi-8kQm2LpXsA
```

The subject defaults to `<user>@<hostname>`, which is fine for your first
identity but makes two of them look alike in the admin's list. Give later ones
a `--subject` that says which is which — it is the label whoever approves the
NHI will see.

Each gets its own port, so run one `serve` per identity you want live, and
point each tool at the port of the identity it should act as. With a single
profile `--profile` is never needed; with several it is required, because
nhi-proxy will not guess which identity you meant.

[More on profiles →](docs/usage.md#profiles)

**Prerequisite:** the platform's simple-directory must run with `manageNhis`
enabled, or every exchange returns 404. `nhi-proxy` says so explicitly when that
happens.

## Documentation

- **[Usage guide](docs/usage.md)** — profiles, wiring each tool, troubleshooting
- **[Security](docs/security.md)** — threat model, and keeping the key away from
  your agent
- [Design spec](docs/superpowers/specs/2026-09-10-nhi-proxy-design.md)
- [Contributing](CONTRIBUTING.md)

## License

AGPL-3.0-only
