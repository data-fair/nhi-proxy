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

Point `XDG_CONFIG_HOME` at a scratch directory so you never touch your real
profiles:

```bash
export XDG_CONFIG_HOME=$(mktemp -d)
node bin/nhi-proxy.ts setup --site https://koumoul.com < /dev/null
node bin/nhi-proxy.ts profiles
node bin/nhi-proxy.ts ca --spki
```

`setup` prompts only when stdin is a TTY; redirecting from `/dev/null` runs it
from flags alone, which is also how the tests drive it.

### Driving a real request through the proxy

The steps above stop short of a working identity, because enrolling one needs
a platform and an org admin. The e2e stack provides both, so you can play all
three roles yourself and watch an unauthenticated `curl` come back
authenticated.

```bash
# 1. an isolated simple-directory to talk to
npm run e2e-stack

# 2. a scratch profile pointed at it
export XDG_CONFIG_HOME=$(mktemp -d)
eval "$(node test-e2e/seed.ts)"   # exports E2E_SITE, E2E_SD_PATH, E2E_ORG_ID, E2E_ADMIN_COOKIE
node bin/nhi-proxy.ts setup --site "$E2E_SITE" --sd-path "$E2E_SD_PATH" \
                           --profile dev < /dev/null

# 3. play the org admin: register the identity nhi-proxy just generated
ISSUER=$(node bin/nhi-proxy.ts status --profile dev | awk '/^issuer/{print $2}')
SUBJECT=$(node bin/nhi-proxy.ts status --profile dev | awk '/^subject/{print $2}')
JWKS=$(node bin/nhi-proxy.ts status --jwks --profile dev)
CLIENT_ID=$(curl -s -X POST "$E2E_SITE$E2E_SD_PATH/api/organizations/$E2E_ORG_ID/nhis" \
  -H 'content-type: application/json' -H "cookie: $E2E_ADMIN_COOKIE" \
  -d "{\"name\":\"dev agent\",\"role\":\"admin\",\"subject\":\"$SUBJECT\",\"provider\":{\"issuer\":\"$ISSUER\",\"jwks\":$JWKS}}" \
  | node -pe "JSON.parse(require('fs').readFileSync(0,'utf8')).id")

# 4. enrol it and start the proxy
node bin/nhi-proxy.ts enroll "$CLIENT_ID" --profile dev
node bin/nhi-proxy.ts serve --profile dev &

# 5. a request carrying no credential of its own
curl -s --noproxy '' --proxy http://127.0.0.1:7331 \
  "$E2E_SITE$E2E_SD_PATH/api/auth/me"
```

```json
{
  "id": "nhi-pXW8ve1vqE",
  "email": "nhi-pXW8ve1vqE@nhi.localhost",
  "name": "dev agent",
  "organizations": [
    { "id": "test_nhilocal", "name": "nhi-proxy e2e org", "role": "admin", "createdAt": "..." }
  ],
  "ipa": 1,
  "nhi": 1,
  "exp": 1789052064,
  "iat": 1789051944
}
```

`nhi: 1` is the proof: simple-directory recognised the session as a non-human
identity, and the curl command never saw a credential.

**`--noproxy ''` is not optional here.** curl skips the proxy for `localhost`
whenever `no_proxy` is set in your shell, and then quietly returns an anonymous
response — a `200` with an empty body, which looks like a bug in nhi-proxy
rather than a bypass. The flag beats the environment variable; note that
setting `NO_PROXY=""` does *not* help, because curl reads the lowercase
`no_proxy` first. Against an https platform you would also pass
`--cacert "$(node bin/nhi-proxy.ts ca --profile dev)"`.

Clean up with:

```bash
kill %1                    # the proxy
npm run e2e-stack-down
```

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
