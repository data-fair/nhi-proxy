import { test } from 'node:test'
import assert from 'node:assert'
import { diagnose } from './diagnose.ts'

const base = { site: 'https://koumoul.com', clientId: 'nhi-V1StGXR8Z5' }

test('404 means the feature is not enabled on the deployment', () => {
  assert.match(diagnose({ ...base, status: 404 }), /not enabled/i)
})

test('429 means the shared auth rate limiter tripped', () => {
  assert.match(diagnose({ ...base, status: 429 }), /rate limit/i)
})

test('401 with a skewed server clock names the skew', () => {
  const now = Date.parse('2026-09-10T12:00:00Z')
  const msg = diagnose({
    ...base,
    status: 401,
    now,
    dateHeader: new Date(now - 5 * 60_000).toUTCString() // server is 5 min behind us
  })
  assert.match(msg, /clock/i)
  assert.match(msg, /5m/)
})

test('401 with an aligned clock falls back to the configuration checklist', () => {
  const now = Date.parse('2026-09-10T12:00:00Z')
  const msg = diagnose({ ...base, status: 401, now, dateHeader: new Date(now).toUTCString() })
  assert.doesNotMatch(msg, /clock/i)
  assert.match(msg, /site|jwks|client_id/i)
})

test('401 with no client_id says enrollment has not happened', () => {
  assert.match(diagnose({ site: base.site, status: 401 }), /enroll/i)
})
