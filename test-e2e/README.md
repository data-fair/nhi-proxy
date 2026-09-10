# End-to-end test

The only test that proves the whole chain against a real simple-directory:
key → assertion → exchange → cookie capture → proxy injection → authenticated
response. It is kept out of `npm test` because it needs a live server.

## Prerequisites

A running simple-directory with **`manageNhis` enabled**. Confirm the endpoint
is mounted — a `401` or `400` proves it is, a `404` means the feature is off:

```bash
curl -s -o /dev/null -w '%{http_code}\n' \
  -X POST http://localhost:5600/simple-directory/api/auth/nhi-token \
  -H 'content-type: application/json' -d '{"client_id":"nhi-x","assertion":"x"}'
```

## Environment

| Variable | Meaning |
|---|---|
| `E2E_SITE` | Platform origin. Default `http://localhost:5600` |
| `E2E_SD_PATH` | simple-directory mount path. Default `/simple-directory` |
| `E2E_ORG_ID` | Organization the NHI is created in |
| `E2E_ADMIN_COOKIE` | An org admin's session cookies |

To get `E2E_ADMIN_COOKIE`: log into the dev stack as an org admin, open the
browser devtools, and copy the `id_token`, `id_token_sign` and `id_token_org`
cookies into one header string.

## Running

```bash
E2E_ADMIN_COOKIE='id_token=...; id_token_sign=...; id_token_org=...' \
E2E_ORG_ID=<org id> \
npm run test-e2e
```

The test creates its own NHI and deletes it afterwards. It writes its profile to
a temporary `XDG_CONFIG_HOME`, so your real profiles are never touched.
