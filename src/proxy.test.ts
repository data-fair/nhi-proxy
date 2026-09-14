import { test } from 'node:test'
import assert from 'node:assert'
import http from 'node:http'
import https from 'node:https'
import net from 'node:net'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { generateCa, loadCa, certForHost, type CaBundle } from './ca.ts'
import { startProxy } from './proxy.ts'

// a SessionHolder-shaped stub; the proxy reads cookieHeader and setCookie
const stubSession = (header: string | Error, setCookie: string[] = []) => ({
  calls: 0,
  setCookie,
  async cookieHeader () { this.calls++; if (header instanceof Error) throw header; return header },
  invalidate () {}
})

const freshCa = async () => {
  const dir = await mkdtemp(join(tmpdir(), 'nhi-'))
  await generateCa(dir)
  return loadCa(dir)
}

const upstream = async (ca: CaBundle, hostname: string, ownSetCookie?: string[]) => {
  const { cert, key } = certForHost(ca, hostname)
  const server = https.createServer({ cert, key }, (req, res) => {
    res.setHeader('content-type', 'text/plain')
    if (ownSetCookie) res.setHeader('set-cookie', ownSetCookie)
    res.end(JSON.stringify({ url: req.url, cookie: req.headers.cookie ?? null }))
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  return { server, port: (server.address() as any).port }
}

// CONNECT through the proxy, then speak TLS over the tunnel
const throughProxy = (proxyPort: number, hostHeader: string, caPem: string, path = '/', cookie?: string) =>
  new Promise<{ body: string, headers: http.IncomingHttpHeaders }>((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1', port: proxyPort, method: 'CONNECT', path: hostHeader
    })
    req.on('connect', (_res, socket) => {
      const host = hostHeader.split(':')[0]
      // speak TLS over the established CONNECT tunnel. `socket` is honoured by
      // https.request at runtime but is absent from its typed options, hence
      // the assertion rather than a restructure.
      const tlsReq = https.request({
        socket,
        servername: host,
        ca: caPem,
        path,
        headers: cookie ? { host, cookie } : { host },
        agent: false
      } as https.RequestOptions, res => {
        let b = ''
        res.on('data', c => { b += c })
        res.on('end', () => resolve({ body: b, headers: res.headers }))
      })
      tlsReq.on('error', reject)
      tlsReq.end()
    })
    req.on('error', reject)
    req.end()
  })

test('injects session cookies into requests to the target host', async () => {
  const ca = await freshCa()
  const session = stubSession('id_token=a.b; id_token_org=myorg')
  const up = await upstream(ca, 'site.example.com')

  const proxy = await startProxy({
    port: 0,
    targetHost: 'site.example.com',
    ca,
    session: session as any,
    // the test upstream listens on 127.0.0.1, so redirect the target there;
    // it presents a cert from our own CA, so the proxy must trust that CA
    upstreamOverride: { host: '127.0.0.1', port: up.port, ca: ca.caCertPem }
  })

  const { body } = await throughProxy(proxy.port, 'site.example.com:443', ca.caCertPem, '/api/v1/datasets')
  const parsed = JSON.parse(body)
  assert.equal(parsed.url, '/api/v1/datasets')
  assert.equal(parsed.cookie, 'id_token=a.b; id_token_org=myorg')
  await proxy.close(); up.server.close()
})

test('tunnels a non-target host without inspecting or re-signing it', async () => {
  const ca = await freshCa()
  const session = stubSession('id_token=a.b')

  // a plain TCP echo server stands in for "some other host"
  const other = net.createServer(s => s.pipe(s))
  await new Promise<void>(resolve => other.listen(0, '127.0.0.1', resolve))
  const otherPort = (other.address() as any).port

  const proxy = await startProxy({ port: 0, targetHost: 'site.example.com', ca, session: session as any })

  const echoed = await new Promise<string>((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1', port: proxy.port, method: 'CONNECT', path: `127.0.0.1:${otherPort}`
    })
    req.on('connect', (_res, socket) => {
      socket.write('PING')
      socket.once('data', d => { resolve(d.toString()); socket.end() })
    })
    req.on('error', reject)
    req.end()
  })

  assert.equal(echoed, 'PING', 'bytes pass through untouched')
  assert.equal(session.calls, 0, 'no session is fetched for a tunnelled host')
  await proxy.close(); other.close()
})

// undici's ProxyAgent (and others) tunnel every scheme through CONNECT, so a
// plain-http dev-stack target must not be met with a TLS handshake
test('a CONNECT tunnel to a plain-http target carries clear HTTP', async () => {
  const ca = await freshCa()
  const session = stubSession('id_token=a.b; id_token_org=myorg')

  const up = http.createServer((req, res) => {
    res.end(JSON.stringify({ url: req.url, cookie: req.headers.cookie ?? null }))
  })
  await new Promise<void>(resolve => up.listen(0, '127.0.0.1', resolve))
  const upPort = (up.address() as any).port

  // no upstreamOverride here on purpose: this exercises targetHost/targetPort,
  // the path a real dev-stack target takes
  const proxy = await startProxy({
    port: 0,
    targetHost: '127.0.0.1',
    targetSecure: false,
    targetPort: upPort,
    ca,
    session: session as any
  })

  const body = await new Promise<string>((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1', port: proxy.port, method: 'CONNECT', path: `127.0.0.1:${upPort}`
    })
    req.on('connect', (_res, socket) => {
      // speak HTTP directly over the tunnel: node's http.request insists on
      // dialling the host itself rather than reusing a socket we hand it
      socket.write('GET /api/auth/me HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n')
      let raw = ''
      socket.on('data', c => { raw += c })
      socket.on('end', () => resolve(raw.slice(raw.indexOf('\r\n\r\n') + 4)))
      socket.on('error', reject)
    })
    req.on('error', reject)
    req.end()
  })

  const parsed = JSON.parse(body)
  assert.equal(parsed.url, '/api/auth/me')
  assert.equal(parsed.cookie, 'id_token=a.b; id_token_org=myorg')
  await proxy.close(); up.close()
})

test('a failed refresh returns 502 naming the cause, never an unauthenticated request', async () => {
  const ca = await freshCa()
  const session = stubSession(new Error('Local clock is 5m00s ahead of https://koumoul.com'))
  const up = await upstream(ca, 'site.example.com')

  const proxy = await startProxy({
    port: 0,
    targetHost: 'site.example.com',
    ca,
    session: session as any,
    upstreamOverride: { host: '127.0.0.1', port: up.port, ca: ca.caCertPem }
  })

  const { body } = await throughProxy(proxy.port, 'site.example.com:443', ca.caCertPem)
  assert.match(body, /nhi-proxy/)
  assert.match(body, /clock is 5m00s ahead/)
  await proxy.close(); up.server.close()
})

// a listen failure must reach the caller: an unhandled 'error' event on the
// server would take the whole process down with a stack trace
test('startProxy rejects when the port is taken, instead of crashing', async () => {
  const ca = await freshCa()
  const squatter = net.createServer()
  await new Promise<void>(resolve => squatter.listen(0, '127.0.0.1', resolve))
  const taken = (squatter.address() as any).port

  await assert.rejects(
    startProxy({ port: taken, targetHost: 'site.example.com', ca, session: stubSession('x') as any }),
    (err: any) => err.code === 'EADDRINUSE'
  )
  await new Promise<void>(resolve => squatter.close(() => resolve()))
})

// Injecting cookies upstream authenticates the request but leaves the client's
// own jar empty. curl never notices; a SPA does nothing else — lib-vue decides
// whether it is logged in by decoding document.cookie — so data-fair rendered
// "vous devez être authentifié" over a fully authenticated session.
const SESSION_SET_COOKIE = [
  'id_token=a.b; path=/; samesite=lax',
  'id_token_sign=sig; path=/; httponly',
  'id_token_org=myorg; path=/'
]

test('relays the session Set-Cookie to a client whose jar is empty', async () => {
  const ca = await freshCa()
  const session = stubSession('id_token=a.b; id_token_sign=sig; id_token_org=myorg', SESSION_SET_COOKIE)
  const up = await upstream(ca, 'site.example.com')

  const proxy = await startProxy({
    port: 0,
    targetHost: 'site.example.com',
    ca,
    session: session as any,
    upstreamOverride: { host: '127.0.0.1', port: up.port, ca: ca.caCertPem }
  })

  const { headers } = await throughProxy(proxy.port, 'site.example.com:443', ca.caCertPem)
  assert.deepEqual(headers['set-cookie'], SESSION_SET_COOKIE)
  await proxy.close(); up.server.close()
})

test('stays quiet when the client already holds the current session', async () => {
  const ca = await freshCa()
  const session = stubSession('id_token=a.b; id_token_sign=sig; id_token_org=myorg', SESSION_SET_COOKIE)
  const up = await upstream(ca, 'site.example.com')

  const proxy = await startProxy({
    port: 0,
    targetHost: 'site.example.com',
    ca,
    session: session as any,
    upstreamOverride: { host: '127.0.0.1', port: up.port, ca: ca.caCertPem }
  })

  const { headers } = await throughProxy(
    proxy.port, 'site.example.com:443', ca.caCertPem, '/',
    'id_token=a.b; id_token_sign=sig; id_token_org=myorg'
  )
  assert.equal(headers['set-cookie'], undefined, 'no need to resend what the client has')
  await proxy.close(); up.server.close()
})

test('relays a refreshed session to a client still holding the previous one', async () => {
  const ca = await freshCa()
  const session = stubSession('id_token=FRESH; id_token_sign=sig; id_token_org=myorg', ['id_token=FRESH; path=/'])
  const up = await upstream(ca, 'site.example.com')

  const proxy = await startProxy({
    port: 0,
    targetHost: 'site.example.com',
    ca,
    session: session as any,
    upstreamOverride: { host: '127.0.0.1', port: up.port, ca: ca.caCertPem }
  })

  const { headers } = await throughProxy(
    proxy.port, 'site.example.com:443', ca.caCertPem, '/', 'id_token=STALE'
  )
  assert.deepEqual(headers['set-cookie'], ['id_token=FRESH; path=/'])
  await proxy.close(); up.server.close()
})

test('appends to the cookies the upstream sets rather than replacing them', async () => {
  const ca = await freshCa()
  const session = stubSession('id_token=a.b', ['id_token=a.b; path=/'])
  const up = await upstream(ca, 'site.example.com', ['i18n_lang=fr; path=/'])

  const proxy = await startProxy({
    port: 0,
    targetHost: 'site.example.com',
    ca,
    session: session as any,
    upstreamOverride: { host: '127.0.0.1', port: up.port, ca: ca.caCertPem }
  })

  const { headers } = await throughProxy(proxy.port, 'site.example.com:443', ca.caCertPem)
  assert.deepEqual(headers['set-cookie'], ['i18n_lang=fr; path=/', 'id_token=a.b; path=/'])
  await proxy.close(); up.server.close()
})

// server.close() fires its callback only once every connection has ended, and
// a browser holds its CONNECT tunnels open with keep-alive. That left Ctrl+C
// hanging with the port still bound. Note closeAllConnections() does not help
// here: the tunnel socket is handed to the inner server with emit('connection'),
// which bypasses the tracking that method walks — so the sockets are tracked
// explicitly instead.
test('close() returns even while a client holds an open tunnel', async () => {
  const ca = await freshCa()
  const session = stubSession('id_token=a.b', ['id_token=a.b; path=/'])
  const up = await upstream(ca, 'site.example.com')

  const proxy = await startProxy({
    port: 0,
    targetHost: 'site.example.com',
    ca,
    session: session as any,
    upstreamOverride: { host: '127.0.0.1', port: up.port, ca: ca.caCertPem }
  })

  const tunnel = await new Promise<net.Socket>((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1', port: proxy.port, method: 'CONNECT', path: 'site.example.com:443'
    })
    req.on('connect', (_res, socket) => resolve(socket))
    req.on('error', reject)
    req.end()
  })

  const outcome = await Promise.race([
    proxy.close().then(() => 'closed'),
    new Promise(resolve => setTimeout(() => resolve('hung'), 2000))
  ])
  assert.equal(outcome, 'closed', 'a held tunnel must not keep the daemon alive')

  tunnel.destroy(); up.server.close()
})
