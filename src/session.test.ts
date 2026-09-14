import { test } from 'node:test'
import assert from 'node:assert'
import http from 'node:http'
import { mkdtemp, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { generateSigningKey, loadSigningKey } from './keys.ts'
import { SessionHolder } from './session.ts'

// a stand-in for simple-directory's /api/auth/nhi-token
const fakeSd = async (handler: (req: http.IncomingMessage, res: http.ServerResponse) => void) => {
  const calls: string[] = []
  const server = http.createServer((req, res) => { calls.push(req.url!); handler(req, res) })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as any).port
  return { server, calls, origin: `http://127.0.0.1:${port}` }
}

// simple-directory's default jwtDurations.nhiToken
const NHI_TOKEN_SEC = 1800

// The session length is NOT a free parameter of the fixture: the real route
// computes exp = min(assertion.exp, now + nhiToken), so a handler that answers
// a flat 1800 describes a server that cannot exist. Deriving it from the posted
// assertion keeps the fixture honest if ASSERTION_LIFETIME_SEC ever moves.
const sessionLengthFor = (assertion: string, nhiTokenSec = NHI_TOKEN_SEC) => {
  const payload = JSON.parse(Buffer.from(assertion.split('.')[1], 'base64url').toString())
  const nowSec = Math.floor(Date.now() / 1000)
  return Math.min(payload.exp - nowSec, nhiTokenSec)
}

const readBody = async (req: http.IncomingMessage) => {
  let raw = ''
  for await (const chunk of req) raw += chunk
  return JSON.parse(raw) as { client_id: string, assertion: string }
}

const okHandler = (nhiTokenSec = NHI_TOKEN_SEC) => (req: http.IncomingMessage, res: http.ServerResponse) => {
  readBody(req).then(body => {
    res.setHeader('Set-Cookie', [
      'id_token=head.payload; path=/; samesite=lax',
      'id_token_sign=sig; path=/; httponly',
      'id_token_org=myorg; path=/'
    ])
    res.setHeader('Content-Type', 'application/json')
    res.end(JSON.stringify({
      access_token: 'head.payload.sig',
      token_type: 'Bearer',
      expires_in: sessionLengthFor(body.assertion, nhiTokenSec)
    }))
  })
}

const holderFor = async (origin: string) => {
  const dir = await mkdtemp(join(tmpdir(), 'nhi-'))
  await generateSigningKey(dir)
  const { key, kid } = await loadSigningKey(dir)
  return new SessionHolder({
    config: {
      site: origin,
      sdPath: '',
      clientId: 'nhi-test01',
      port: 7331,
      issuer: 'https://nhi-proxy.data-fair.cloud/test',
      subject: 'test@host'
    },
    key,
    kid
  })
}

test('exchanges on first use and returns the captured cookies', async () => {
  const sd = await fakeSd(okHandler())
  const holder = await holderFor(sd.origin)
  assert.equal(holder.state.expiresAt, null, 'no exchange happens at construction')
  const header = await holder.cookieHeader()
  assert.equal(header, 'id_token=head.payload; id_token_sign=sig; id_token_org=myorg')
  assert.deepEqual(sd.calls, ['/api/auth/nhi-token'])
  sd.server.close()
})

test('reuses a fresh session instead of exchanging again', async () => {
  const sd = await fakeSd(okHandler())
  const holder = await holderFor(sd.origin)
  await holder.cookieHeader()
  await holder.cookieHeader()
  assert.equal(sd.calls.length, 1)
  sd.server.close()
})

test('re-exchanges once the session is inside the refresh margin', async () => {
  // a 2s session gets a ~667ms margin, so it goes stale within the test
  const sd = await fakeSd(okHandler(2))
  const holder = await holderFor(sd.origin)
  await holder.cookieHeader()
  await holder.cookieHeader()
  assert.equal(sd.calls.length, 1, 'still fresh')
  await new Promise(resolve => setTimeout(resolve, 1500))
  await holder.cookieHeader()
  assert.equal(sd.calls.length, 2, 'inside the margin, so refreshed')
  sd.server.close()
})

// The regression this whole file exists to prevent. The proxy's own assertion
// lives 120s and the server caps the session at min(assertion.exp, nhiToken),
// so a real session is ~120s — far inside a fixed 300s margin. That made every
// single proxied request trigger an exchange, and simple-directory's auth
// limiter (5 points/60s, charged on success, keyed by IP and by client_id)
// tripped within one page load.
test('a burst of sequential requests on a real-length session exchanges once', async () => {
  const sd = await fakeSd(okHandler())
  const holder = await holderFor(sd.origin)
  for (let i = 0; i < 10; i++) await holder.cookieHeader()
  assert.equal(sd.calls.length, 1, 'a live session must be reused, not re-exchanged')
  sd.server.close()
})

test('the refresh margin is derived from the session actually granted', async () => {
  const sd = await fakeSd(okHandler())
  const holder = await holderFor(sd.origin)
  await holder.cookieHeader()
  // 120s session => 40s margin, so a refresh lands around t+80s: well under the
  // limiter's 5/min, and nowhere near the every-request behaviour of the bug
  assert.equal(holder.state.refreshMarginMs, 40_000)
  sd.server.close()
})

// Without this the proxy answers 502 while holding a session that still works,
// and every retry spends another limiter point keeping the bucket empty.
test('a failed refresh keeps serving the still-valid session', async () => {
  let fail = false
  const sd = await fakeSd((req, res) => {
    if (fail) { res.statusCode = 429; res.end('rate limited'); return }
    okHandler(4)(req, res)
  })
  const holder = await holderFor(sd.origin)
  const first = await holder.cookieHeader()
  fail = true
  // past the margin (4s session => 1.33s margin) so a refresh is attempted
  await new Promise(resolve => setTimeout(resolve, 3000))
  const during = await holder.cookieHeader()
  assert.equal(during, first, 'the unexpired session is served rather than a 502')
  sd.server.close()
})

test('after a failed exchange it backs off instead of retrying every request', async () => {
  const sd = await fakeSd((_req, res) => { res.statusCode = 429; res.end('rate limited') })
  const holder = await holderFor(sd.origin)
  await assert.rejects(holder.cookieHeader(), /rate limit/i)
  for (let i = 0; i < 10; i++) {
    await assert.rejects(holder.cookieHeader(), /rate limit/i)
  }
  assert.equal(sd.calls.length, 1, 'one attempt, then backoff — not one per request')
  sd.server.close()
})

test('a Retry-After header sets the backoff, and it clears once it lapses', async () => {
  let fail = true
  const sd = await fakeSd((req, res) => {
    if (fail) {
      res.statusCode = 429
      res.setHeader('Retry-After', '1')
      res.end('rate limited')
      return
    }
    okHandler()(req, res)
  })
  const holder = await holderFor(sd.origin)
  await assert.rejects(holder.cookieHeader(), /rate limit/i)
  await assert.rejects(holder.cookieHeader(), /rate limit/i)
  assert.equal(sd.calls.length, 1, 'still backing off')
  fail = false
  await new Promise(resolve => setTimeout(resolve, 1200))
  await holder.cookieHeader()
  assert.equal(sd.calls.length, 2, 'the 1s Retry-After was honoured, then retried')
  sd.server.close()
})

// the raw Set-Cookie is what the browser needs: it carries path/expires and the
// httpOnly split (id_token readable by the SPA, id_token_sign not)
test('the raw Set-Cookie headers of the exchange are kept for relaying', async () => {
  const sd = await fakeSd(okHandler())
  const holder = await holderFor(sd.origin)
  await holder.cookieHeader()
  assert.deepEqual(holder.setCookie, [
    'id_token=head.payload; path=/; samesite=lax',
    'id_token_sign=sig; path=/; httponly',
    'id_token_org=myorg; path=/'
  ])
  sd.server.close()
})

// the rate limiter consumes a point on every successful exchange, so a burst
// of parallel requests must not become a burst of exchanges
test('concurrent callers share a single in-flight exchange', async () => {
  const sd = await fakeSd((req, res) => setTimeout(() => okHandler()(req, res), 50))
  const holder = await holderFor(sd.origin)
  const headers = await Promise.all(Array.from({ length: 20 }, () => holder.cookieHeader()))
  assert.equal(sd.calls.length, 1)
  assert.equal(new Set(headers).size, 1)
  sd.server.close()
})

test('a 404 surfaces the feature-not-enabled diagnosis', async () => {
  const sd = await fakeSd((_req, res) => { res.statusCode = 404; res.end('nhi support is not activated') })
  const holder = await holderFor(sd.origin)
  await assert.rejects(holder.cookieHeader(), /not enabled/i)
  assert.match(holder.state.lastError!, /not enabled/i)
  sd.server.close()
})

test('a 401 surfaces the client-side checklist', async () => {
  const sd = await fakeSd((_req, res) => { res.statusCode = 401; res.end('invalid credentials') })
  const holder = await holderFor(sd.origin)
  await assert.rejects(holder.cookieHeader(), /same 401 for every cause/i)
  sd.server.close()
})

// invariant: session cookies live in memory only and are never written to disk
test('an exchange writes nothing to the profile directory', async () => {
  const sd = await fakeSd(okHandler())
  const dir = await mkdtemp(join(tmpdir(), 'nhi-'))
  await generateSigningKey(dir)
  const { key, kid } = await loadSigningKey(dir)
  const before = (await readdir(dir)).sort()
  const holder = new SessionHolder({
    config: {
      site: sd.origin,
      sdPath: '',
      clientId: 'nhi-test01',
      port: 7331,
      issuer: 'https://nhi-proxy.data-fair.cloud/test',
      subject: 'test@host'
    },
    key,
    kid
  })
  await holder.cookieHeader()
  assert.deepEqual((await readdir(dir)).sort(), before, 'no new file may appear')
  sd.server.close()
})

test('invalidate forces the next call to exchange again', async () => {
  const sd = await fakeSd(okHandler())
  const holder = await holderFor(sd.origin)
  await holder.cookieHeader()
  holder.invalidate()
  await holder.cookieHeader()
  assert.equal(sd.calls.length, 2)
  sd.server.close()
})
