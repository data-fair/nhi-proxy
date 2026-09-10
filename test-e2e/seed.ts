/**
 * Seeds the e2e stack with one organization and one admin of it, then logs that
 * admin in and prints the environment the e2e test needs.
 *
 * Users are written straight into mongo with a `{ clear }` password, which
 * simple-directory's checkPassword accepts (see api/src/utils/passwords.ts) —
 * this avoids the email-confirmation round trip that the real signup flow needs.
 */
import { MongoClient } from 'mongodb'

const MONGO = process.env.E2E_MONGO_URL ?? 'mongodb://localhost:27317/nhi-local-e2e'
const SITE = process.env.E2E_SITE ?? 'http://localhost:5690'
const SD_PATH = process.env.E2E_SD_PATH ?? '/simple-directory'

const ORG_ID = 'test_nhilocal'
const ADMIN_EMAIL = 'nhi-admin@test.com'
const ADMIN_PASSWORD = 'TestPasswd01'

const client = new MongoClient(MONGO)
await client.connect()
const db = client.db()

await db.collection('organizations').replaceOne(
  { _id: ORG_ID as any },
  { _id: ORG_ID, name: 'nhi-local e2e org', created: { id: ADMIN_EMAIL, name: 'seed', date: new Date().toISOString() } } as any,
  { upsert: true }
)

await db.collection('users').replaceOne(
  { _id: 'test_nhiadmin' as any },
  {
    _id: 'test_nhiadmin',
    email: ADMIN_EMAIL,
    firstName: 'NHI',
    lastName: 'Admin',
    name: 'NHI Admin',
    emailConfirmed: true,
    password: { clear: ADMIN_PASSWORD },
    organizations: [{ id: ORG_ID, name: 'nhi-local e2e org', role: 'admin' }]
  } as any,
  { upsert: true }
)
await client.close()

// log in the way a browser does, and keep the session cookies
const res = await fetch(`${SITE}${SD_PATH}/api/auth/password`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD, org: ORG_ID })
})
if (!res.ok) throw new Error(`admin login failed: ${res.status} ${await res.text()}`)

// in ajax mode the password route answers with a token_callback URL carrying a
// temporary token; fetching it is what actually mints the session cookies
const callbackUrl = (await res.text()).trim()
if (!callbackUrl.startsWith('http')) throw new Error(`unexpected login response: ${callbackUrl}`)
const callback = await fetch(callbackUrl, { redirect: 'manual' })

const cookies = callback.headers.getSetCookie()
  .map(c => c.split(';')[0])
  .filter(c => c.split('=')[1])
  .join('; ')
if (!cookies.includes('id_token=')) {
  throw new Error(`callback set no session cookie (status ${callback.status})`)
}

// consumed by `npm run test-e2e`
console.log(`export E2E_SITE='${SITE}'`)
console.log(`export E2E_SD_PATH='${SD_PATH}'`)
console.log(`export E2E_ORG_ID='${ORG_ID}'`)
console.log(`export E2E_ADMIN_COOKIE='${cookies}'`)
