# Contributing

## Setup

Switch to the appropriate Node.js version, then install:

```bash
nvm use
npm install
```

There is no build step. Node 24 runs the TypeScript sources directly via type
stripping, which is why `enum`, `namespace` and decorators are unavailable and
type-only imports must use `import type`.

## Scripts

| Script | What it does |
|---|---|
| `npm test` | Unit tests (`node --test`, colocated `src/**/*.test.ts`) |
| `npm run lint` / `lint-fix` | eslint (neostandard) |
| `npm run check-types` | `tsc --noEmit` |
| `npm run quality` | All three — run this before committing |
| `npm run e2e` | Bring up an isolated simple-directory in Docker, seed it, run the end-to-end test |
| `npm run e2e-stack` / `e2e-stack-down` | Manage that stack on its own |
| `npm run test-e2e` | End-to-end test against a stack you configured via `E2E_*` |

Commits follow [conventional commits](https://www.conventionalcommits.org)
(commitlint).

## Layout

| Path | Responsibility |
|---|---|
| `bin/nhi-proxy.ts` | Entry point: `parseArgs` dispatch. No logic. |
| `src/paths.ts` | Profile directories, secure file read/write (0600/0700) |
| `src/config.ts` | Config record type, read/write |
| `src/profiles.ts` | Profile discovery, resolution rules, port assignment |
| `src/keys.ts` | ES256 signing keypair, public JWKS |
| `src/assertion.ts` | Mints one assertion |
| `src/ca.ts` | Local CA, per-host certificates, SPKI pin |
| `src/cookies.ts` | `Set-Cookie` capture and merging |
| `src/session.ts` | Exchange, cookie holder, rotation, in-flight dedup |
| `src/diagnose.ts` | Turns an opaque exchange failure into an actionable message |
| `src/proxy.ts` | CONNECT routing, interception, injection |
| `src/commands/` | One file per CLI command |

The [design spec](docs/superpowers/specs/2026-09-10-nhi-proxy-design.md) is the
reference for *why* each of these behaves as it does, and carries the invariants
any change must preserve.

## Testing

**Unit tests are colocated** and run against real machinery rather than mocks
wherever it is cheap to: `ca.test.ts` serves over a real `node:https` server,
`proxy.test.ts` drives real CONNECT tunnels, `session.test.ts` runs a stand-in
simple-directory over `node:http`.

**The end-to-end test is the only one that proves the whole chain** — key →
assertion → exchange → cookie capture → injection → an authenticated response.
It found two proxy bugs the unit tests could not, so keep it runnable:

```bash
npm run e2e
```

See [`test-e2e/README.md`](test-e2e/README.md) for what the stack is and the
four non-obvious things simple-directory needs to run standalone.

## Trying it by hand

Two flows, and they want different config directories — mixing them is the
easiest way to confuse yourself.

### Against a scratch profile

For poking at the CLI without a platform. `XDG_CONFIG_HOME` keeps it away from
your real profiles — but **do not enrol a scratch profile against a real
platform**: see the warning below.

```bash
export XDG_CONFIG_HOME=$(mktemp -d)
node bin/nhi-proxy.ts setup --site https://koumoul.com < /dev/null
node bin/nhi-proxy.ts profiles
node bin/nhi-proxy.ts ca --spki
```

`setup` prompts only when stdin is a TTY; redirecting from `/dev/null` runs it
from flags alone, which is also how the tests drive it.

### Against a real platform

This one uses your real `~/.config/nhi-proxy`, so run it in a shell **without**
the `XDG_CONFIG_HOME` override above. Enrolling a profile that lives in a temp
directory leaves you worse off than not enrolling at all: when the directory is
cleared you lose the signing key, while the NHI stays registered in the
organization bound to a key that no longer exists anywhere — an orphan only an
admin can remove. If you have already done it, move the profile out (see
[moving a profile](docs/usage.md#moving-or-backing-up-a-profile)) rather than
enrolling a second one.

```bash
node bin/nhi-proxy.ts setup --site https://koumoul.com
# hand the printed issuer / subject / jwks to an org admin, then:
node bin/nhi-proxy.ts enroll nhi-V1StGXR8Z5
node bin/nhi-proxy.ts serve &

curl --proxy http://127.0.0.1:7331 \
     --cacert ~/.config/nhi-proxy/koumoul.com/ca.crt \
     https://koumoul.com/simple-directory/api/auth/me
```

```json
{
  "id": "nhi-V1StGXR8Z5",
  "name": "my agent",
  "organizations": [{ "id": "...", "name": "...", "role": "user" }],
  "ipa": 1,
  "nhi": 1,
  "exp": 1789052064,
  "iat": 1789051944
}
```

`nhi: 1` is the proof: simple-directory recognised the session as a non-human
identity, and curl never saw a credential. Swap the URL for any endpoint on
that platform — `/data-fair/api/v1/datasets`, say — and it stays authenticated.

`--cacert` is needed because the proxy terminates TLS for the target host with
its own CA. `nhi-proxy ca` prints that path, but **do not inline it as
`--cacert "$(nhi-proxy ca)"`**: when there is no profile yet the command writes
its error to stderr and nothing to stdout, so curl receives an empty path and
reports `error setting certificate file:` — which tells you nothing about the
actual cause. Paste the path, or assign it first and check it.

Against a plain-http dev stack, drop `--cacert` but add `--noproxy ''`: curl
skips the proxy for `localhost` whenever `no_proxy` is set, then quietly
returns an anonymous `200` that reads as a bug rather than a bypass. Setting
`NO_PROXY=""` does not help, because curl reads the lowercase `no_proxy` first.

If you have no platform to point at, `npm run e2e` does all of the above
against a throwaway simple-directory it brings up itself.

## Things to be careful about

These are load-bearing. Read the spec section before changing any of them.

- **Never log, print, or return a credential** — signing key, assertion, or
  session cookie. The only thing `setup` prints is the *public* JWKS.
- **Session cookies stay in memory.** `src/session.ts` must not gain a
  filesystem import; a test asserts the profile directory is untouched by an
  exchange.
- **The proxy intercepts exactly one host.** Every other CONNECT is tunnelled
  byte-for-byte, uninspected.
- **A failed refresh returns 502**, never an unauthenticated request.
- **With several profiles and no `--profile`, refuse.** Guessing points one
  organization's credential at another organization's platform.
