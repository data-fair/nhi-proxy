import { test } from 'node:test'
import assert from 'node:assert'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import https from 'node:https'
import { generateCa, loadCa, certForHost, spkiPin } from './ca.ts'

const setup = async () => {
  const dir = await mkdtemp(join(tmpdir(), 'nhi-'))
  await generateCa(dir)
  return loadCa(dir)
}

test('a minted certificate is accepted by node TLS when the CA is trusted', async () => {
  const ca = await setup()
  const { cert, key } = certForHost(ca, 'site.example.com')
  const server = https.createServer({ cert, key }, (req, res) => res.end('ok'))
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as any).port
  const body = await new Promise<string>((resolve, reject) => {
    https.get({
      host: '127.0.0.1',
      port,
      path: '/',
      servername: 'site.example.com', // SNI, as the proxy sets it
      ca: ca.caCertPem // trust ONLY our CA
    }, res => {
      let b = ''
      res.on('data', c => { b += c })
      res.on('end', () => resolve(b))
    }).on('error', reject)
  })
  assert.equal(body, 'ok')
  server.close()
})

test('the SPKI pin is stable across hostnames', async () => {
  const ca = await setup()
  const a = certForHost(ca, 'a.example.com')
  const b = certForHost(ca, 'b.example.com')
  assert.notEqual(a.cert, b.cert, 'each host gets its own certificate')
  assert.equal(a.key, b.key, 'but they share one leaf keypair')
  assert.match(spkiPin(ca), /^[A-Za-z0-9+/]+=*$/)
})

test('certForHost is memoized', async () => {
  const ca = await setup()
  assert.equal(certForHost(ca, 'x.example.com').cert, certForHost(ca, 'x.example.com').cert)
})
