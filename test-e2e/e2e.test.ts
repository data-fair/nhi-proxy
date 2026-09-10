import { test, before, after } from 'node:test'
import assert from 'node:assert'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ProxyAgent } from 'undici'
import { runSetup } from '../src/commands/setup.ts'
import { readConfig, writeConfig } from '../src/config.ts'
import { profileDir } from '../src/paths.ts'
import { loadSigningKey, publicJwks } from '../src/keys.ts'
import { loadCa } from '../src/ca.ts'
import { SessionHolder } from '../src/session.ts'
import { startProxy } from '../src/proxy.ts'
import { listProfiles } from '../src/profiles.ts'

// Point these at a dev stack where manageNhis is true.
const SITE = process.env.E2E_SITE ?? 'http://localhost:5600'
const SD_PATH = process.env.E2E_SD_PATH ?? '/simple-directory'
// an org admin's session cookie, used only to create and delete the NHI
const ADMIN_COOKIE = process.env.E2E_ADMIN_COOKIE!
const ORG_ID = process.env.E2E_ORG_ID!

let proxy: Awaited<ReturnType<typeof startProxy>>
let profile: string
let clientId: string

before(async () => {
  assert.ok(ADMIN_COOKIE && ORG_ID, 'set E2E_ADMIN_COOKIE and E2E_ORG_ID')
  process.env.XDG_CONFIG_HOME = await mkdtemp(join(tmpdir(), 'nhi-e2e-'))

  const setup = await runSetup({ site: SITE, subject: 'e2e@test', sdPath: SD_PATH })
  profile = setup.profile

  // an org admin creates the NHI with our inline JWKS — the step a human
  // performs through the simple-directory UI in normal use
  const res = await fetch(`${SITE}${SD_PATH}/api/organizations/${ORG_ID}/nhis`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: ADMIN_COOKIE },
    body: JSON.stringify({
      name: 'nhi-proxy e2e',
      role: 'user',
      subject: setup.subject,
      provider: { issuer: setup.issuer, jwks: await publicJwks(profileDir(profile)) }
    })
  })
  // read the body once: passing `await res.text()` as an assertion message
  // consumes it eagerly, even when the assertion passes
  const body = await res.text()
  assert.equal(res.status, 201, `NHI creation failed: ${res.status} ${body}`)
  clientId = JSON.parse(body).id

  const config = { ...await readConfig(profile), clientId }
  await writeConfig(profile, config)
  const { key, kid } = await loadSigningKey(profileDir(profile))
  proxy = await startProxy({
    port: 0,
    targetHost: new URL(SITE).hostname,
    targetSecure: new URL(SITE).protocol === 'https:',
    targetPort: new URL(SITE).port ? Number(new URL(SITE).port) : undefined,
    ca: await loadCa(profileDir(profile)),
    session: new SessionHolder({ config, key, kid })
  })
})

after(async () => {
  await proxy?.close()
  if (clientId) {
    await fetch(`${SITE}${SD_PATH}/api/organizations/${ORG_ID}/nhis/${clientId}`,
      { method: 'DELETE', headers: { cookie: ADMIN_COOKIE } })
  }
})

test('a request through the proxy is authenticated as the NHI', async () => {
  // this request carries no credential of its own; the proxy injects the session
  const res = await fetch(`${SITE}${SD_PATH}/api/auth/me`, {
    dispatcher: new ProxyAgent(`http://127.0.0.1:${proxy.port}`)
  } as any)
  // read once: a 502 from nhi-proxy carries the diagnosis in its body
  const raw = await res.text()
  assert.equal(res.status, 200, `proxy returned ${res.status}: ${raw}`)
  const me = JSON.parse(raw)
  assert.equal(me.id, clientId)
  assert.equal(me.nhi, 1, 'the session must carry the nhi flag')
  assert.ok(!me.isAdmin, 'an NHI is never admin')
})

test('the profile is discoverable and reports as enrolled', async () => {
  const found = (await listProfiles()).find(p => p.name === profile)
  assert.ok(found, 'setup must have created a discoverable profile')
  assert.equal(found.config.clientId, clientId)
})
