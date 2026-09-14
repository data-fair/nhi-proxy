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
import { ASSERTION_LIFETIME_SEC } from '../src/assertion.ts'

// Point these at a dev stack where manageNhis is true.
const SITE = process.env.E2E_SITE ?? 'http://localhost:5600'
const SD_PATH = process.env.E2E_SD_PATH ?? '/simple-directory'
// an org admin's session cookie, used only to create and delete the NHI
const ADMIN_COOKIE = process.env.E2E_ADMIN_COOKIE!
const ORG_ID = process.env.E2E_ORG_ID!

let proxy: Awaited<ReturnType<typeof startProxy>>
let profile: string
let clientId: string
let session: SessionHolder

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
  session = new SessionHolder({ config, key, kid })
  proxy = await startProxy({
    port: 0,
    targetHost: new URL(SITE).hostname,
    targetSecure: new URL(SITE).protocol === 'https:',
    targetPort: new URL(SITE).port ? Number(new URL(SITE).port) : undefined,
    ca: await loadCa(profileDir(profile)),
    session
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

// The bug this pair guards was invisible to every unit test, because the fake
// exchange answered a session length the real server cannot grant. Only a real
// simple-directory settles what exp = min(assertion.exp, now + nhiToken)
// actually resolves to, so these assert it here.
test('the session simple-directory really grants is bounded by our assertion', async () => {
  const remainingSec = (session.state.expiresAt! - Date.now()) / 1000
  assert.ok(
    remainingSec <= ASSERTION_LIFETIME_SEC && remainingSec > ASSERTION_LIFETIME_SEC - 30,
    `expected a session near ${ASSERTION_LIFETIME_SEC}s (our assertion caps it), got ${Math.round(remainingSec)}s`
  )
  // the margin must follow that, not a lifetime nobody granted: a fixed 300s
  // margin against this session is what made every request re-exchange
  assert.ok(
    session.state.refreshMarginMs < remainingSec * 1000,
    'a margin wider than the session means nothing is ever fresh'
  )
})

// Sequential on purpose. A parallel burst was always safe — #inFlight collapses
// it into one exchange — and testing only that is what let the bug through: a
// browser loading a page issues requests steadily over several seconds, each
// arriving after the last exchange resolved, so each spent its own point.
//
// Asserted as "the session did not change" rather than "no 429 came back",
// because this stack raises AUTHRATELIMIT_ATTEMPTS to survive repeated runs
// and so cannot observe the limiter at all. Exchange count is the real
// property anyway: the limiter is just what punishes getting it wrong.
test('a run of proxied requests reuses one session instead of re-exchanging', async () => {
  const dispatcher = new ProxyAgent(`http://127.0.0.1:${proxy.port}`)
  const granted = session.state.expiresAt
  const statuses: number[] = []
  for (let i = 0; i < 12; i++) {
    const res = await fetch(`${SITE}${SD_PATH}/api/auth/me`, { dispatcher } as any)
    await res.text()
    statuses.push(res.status)
  }
  assert.deepEqual([...new Set(statuses)], [200], `expected every request to pass, got ${statuses.join(',')}`)
  assert.equal(session.state.expiresAt, granted, 'a live session must be reused: every re-exchange spends a limiter point')
})

test('the browser receives the session in its own jar, not just the upstream', async () => {
  const res = await fetch(`${SITE}${SD_PATH}/api/auth/me`, {
    dispatcher: new ProxyAgent(`http://127.0.0.1:${proxy.port}`)
  } as any)
  await res.text()
  const setCookie = res.headers.getSetCookie()
  // lib-vue decides whether it is signed in by decoding document.cookie, so
  // id_token must reach the client and must stay readable to scripts
  const idToken = setCookie.find(c => c.startsWith('id_token='))
  assert.ok(idToken, `no id_token relayed to the client: ${JSON.stringify(setCookie)}`)
  assert.ok(!/httponly/i.test(idToken), 'the SPA must be able to read id_token')
  assert.ok(setCookie.some(c => /^id_token_sign=/.test(c) && /httponly/i.test(c)), 'id_token_sign stays httpOnly')
})
