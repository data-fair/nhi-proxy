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

const okHandler = (expiresIn = 1800) => (req: http.IncomingMessage, res: http.ServerResponse) => {
  res.setHeader('Set-Cookie', [
    'id_token=head.payload; path=/; samesite=lax',
    'id_token_sign=sig; path=/; httponly',
    'id_token_org=myorg; path=/'
  ])
  res.setHeader('Content-Type', 'application/json')
  res.end(JSON.stringify({ access_token: 'head.payload.sig', token_type: 'Bearer', expires_in: expiresIn }))
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

test('re-exchanges when the session is inside the refresh margin', async () => {
  const sd = await fakeSd(okHandler(60)) // expires in 60s, inside the 300s margin
  const holder = await holderFor(sd.origin)
  await holder.cookieHeader()
  await holder.cookieHeader()
  assert.equal(sd.calls.length, 2)
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
