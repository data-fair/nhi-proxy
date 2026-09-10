# End-to-end test

The only test that proves the whole chain against a real simple-directory:
key → assertion → exchange → cookie capture → proxy injection → an
authenticated response identifying the NHI.

## Run it

```bash
npm run e2e
```

That is the whole thing. It brings up an isolated simple-directory, waits for
the exchange endpoint to answer, seeds an organization plus an admin of it, and
runs the test. Tear it down with `npm run e2e-stack-down`.

## What the stack is

`docker-compose.yml` at the repo root, deliberately isolated from any data-fair
dev stack you may already be running:

| | |
|---|---|
| compose project | `nhi-proxy-e2e` |
| simple-directory | `http://localhost:5690/simple-directory` |
| mongo | `localhost:27317`, **tmpfs** — every run starts empty |

Three details that stack needs, each learned the hard way:

- **`MANAGE_NHIS=true`**, or the exchange endpoint 404s. The published release
  tags predate the NHI feature, so the image is `:master`.
- **`PUBLIC_URL` must carry the `/simple-directory` path.** Without it the app
  answers every request with `URL path does not contain service prefix`.
- **An nginx in front.** simple-directory requires `X-Forwarded-Host`,
  `X-Forwarded-Proto` and `X-Forwarded-For` and refuses requests without them
  (`reqOrigin` / `reqIp` in `@data-fair/lib-express`). The forwarded host must
  keep its port, because the origin it yields *is* the assertion audience.

`AUTHRATELIMIT_ATTEMPTS` is also raised: the auth limiter spends a point on
every exchange, successful or not, and the default of 5 per minute is exhausted
by a couple of runs.

## Seeding

`seed.ts` writes an organization and one admin of it straight into mongo, with a
`{ clear }` password — accepted by simple-directory's `checkPassword` — then
logs that admin in and prints the environment the test needs. The password route
answers in ajax mode with a `token_callback` URL; fetching it is what actually
mints the session cookies.

The test creates its own NHI through the org admin API and deletes it in
`after()`. It writes its profile to a temporary `XDG_CONFIG_HOME`, so your real
profiles are never touched.

## Running against your own stack

Set the environment yourself and call the test directly:

| Variable | Meaning |
|---|---|
| `E2E_SITE` | Platform origin. Default `http://localhost:5690` |
| `E2E_SD_PATH` | simple-directory mount path. Default `/simple-directory` |
| `E2E_ORG_ID` | Organization the NHI is created in |
| `E2E_ADMIN_COOKIE` | An org admin's session cookies |

```bash
E2E_ADMIN_COOKIE='id_token=...; id_token_sign=...; id_token_org=...' \
E2E_ORG_ID=<org id> \
npm run test-e2e
```
