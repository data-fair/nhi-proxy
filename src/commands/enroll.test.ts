import { test } from 'node:test'
import assert from 'node:assert'
import http from 'node:http'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runEnroll } from './enroll.ts'
import { runSetup } from './setup.ts'
import { readConfig } from '../config.ts'

const fakeSd = async (handler: (req: http.IncomingMessage, res: http.ServerResponse) => void) => {
  const server = http.createServer(handler)
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  return { server, origin: `http://127.0.0.1:${(server.address() as any).port}` }
}

const ok = (_req: http.IncomingMessage, res: http.ServerResponse) => {
  res.setHeader('Set-Cookie', ['id_token=head.payload; path=/', 'id_token_sign=sig; path=/'])
  res.setHeader('Content-Type', 'application/json')
  res.end(JSON.stringify({ expires_in: 1800 }))
}

const profileFor = async (origin: string) => {
  process.env.XDG_CONFIG_HOME = await mkdtemp(join(tmpdir(), 'nhi-'))
  await runSetup({ site: origin, sdPath: '', profile: 'p' })
}

// a failed enrolment must leave nothing behind: persisting the client_id would
// make `serve` start happily and every request fail afterwards
test('a rejected exchange does not record the client_id', async () => {
  const sd = await fakeSd((_req, res) => { res.statusCode = 401; res.end('invalid credentials') })
  await profileFor(sd.origin)
  await assert.rejects(runEnroll('nhi-WRONG00001', 'p'))
  assert.equal((await readConfig('p')).clientId, undefined, 'the profile must still be un-enrolled')
  delete process.env.XDG_CONFIG_HOME
  sd.server.close()
})

test('a successful exchange records the client_id', async () => {
  const sd = await fakeSd(ok)
  await profileFor(sd.origin)
  await runEnroll('nhi-GOOD000001', 'p')
  assert.equal((await readConfig('p')).clientId, 'nhi-GOOD000001')
  delete process.env.XDG_CONFIG_HOME
  sd.server.close()
})

test('re-enrolling with a bad id keeps the working one', async () => {
  let reject = false
  const sd = await fakeSd((req, res) => {
    if (reject) { res.statusCode = 401; res.end('invalid credentials') } else ok(req, res)
  })
  await profileFor(sd.origin)
  await runEnroll('nhi-GOOD000001', 'p')
  reject = true
  await assert.rejects(runEnroll('nhi-TYPO000001', 'p'))
  assert.equal((await readConfig('p')).clientId, 'nhi-GOOD000001', 'a typo must not unenrol a working profile')
  delete process.env.XDG_CONFIG_HOME
  sd.server.close()
})
