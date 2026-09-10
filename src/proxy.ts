import http from 'node:http'
import https from 'node:https'
import net from 'node:net'
import tls from 'node:tls'
import { certForHost, type CaBundle } from './ca.ts'
import { mergeCookieHeader } from './cookies.ts'
import type { SessionHolder } from './session.ts'

export type ProxyOptions = {
  port: number
  targetHost: string
  ca: CaBundle
  session: SessionHolder
  /**
   * whether the target is reached over TLS. Defaults to true; set false for a
   * plain-http dev stack, where a CONNECT tunnel carries clear HTTP and must
   * NOT be met with a TLS handshake.
   */
  targetSecure?: boolean
  /**
   * port the target listens on. Defaults to 443/80 by scheme; a dev stack on
   * `http://localhost:5690` needs it, or requests are dialled at port 80.
   */
  targetPort?: number
  /**
   * test-only: send intercepted traffic here instead of the real target.
   * `ca` trusts a self-signed upstream; the real target is verified against
   * the system trust store, which is why this is not a production knob.
   */
  upstreamOverride?: { host: string, port: number, ca?: string }
}

export const startProxy = async (opts: ProxyOptions) => {
  const { targetHost, ca, session } = opts
  const targetSecure = opts.targetSecure ?? true
  const targetPort = opts.targetPort ?? (targetSecure ? 443 : 80)

  // requests arrive here already decrypted, either from an intercepted CONNECT
  // tunnel or as plain HTTP to the target
  const handleIntercepted = async (req: http.IncomingMessage, res: http.ServerResponse, secure: boolean) => {
    let cookie: string
    try {
      cookie = await session.cookieHeader()
    } catch (err: any) {
      // never forward unauthenticated: data-fair would answer 401 or a
      // logged-out HTML page and an agent would burn tokens interpreting it
      res.writeHead(502, { 'content-type': 'text/plain' })
      res.end(`nhi-local: ${err.message}\n`)
      return
    }

    const headers = { ...req.headers }
    headers.cookie = mergeCookieHeader(req.headers.cookie, cookie)
    delete headers['proxy-connection']

    const target = opts.upstreamOverride ?? { host: targetHost, port: targetPort }
    const request = secure ? https.request : http.request
    const upstream = request({
      host: target.host,
      port: target.port,
      servername: secure ? targetHost : undefined,
      method: req.method,
      path: req.url,
      headers,
      ...(opts.upstreamOverride?.ca ? { ca: opts.upstreamOverride.ca } : {})
    }, upRes => {
      res.writeHead(upRes.statusCode ?? 502, upRes.headers)
      upRes.pipe(res)
    })
    upstream.on('error', err => {
      res.writeHead(502, { 'content-type': 'text/plain' })
      res.end(`nhi-local: upstream request failed: ${err.message}\n`)
    })
    req.pipe(upstream)
  }

  // internal TLS server that terminates intercepted CONNECT tunnels; one
  // certificate per SNI name, all sharing the reused leaf key
  const mitm = https.createServer({
    SNICallback: (servername, cb) => {
      const { cert, key } = certForHost(ca, servername)
      cb(null, tls.createSecureContext({ cert, key }))
    }
  })
  mitm.on('request', (req, res) => {
    handleIntercepted(req, res, targetSecure).catch(() => res.destroy())
  })

  // a CONNECT tunnel to a plain-http target carries clear HTTP, not TLS: some
  // clients (undici's ProxyAgent among them) tunnel every scheme. Meeting those
  // bytes with a TLS handshake just closes the socket with no explanation.
  const plainMitm = http.createServer()
  plainMitm.on('request', (req, res) => {
    handleIntercepted(req, res, targetSecure).catch(() => res.destroy())
  })

  const proxy = http.createServer((req, res) => {
    // plain HTTP through the proxy uses absolute-form request URLs
    let host: string | undefined
    try {
      host = new URL(req.url!).hostname
    } catch {
      host = req.headers.host?.split(':')[0]
    }
    if (host !== targetHost) {
      res.writeHead(502, { 'content-type': 'text/plain' })
      res.end(`nhi-local: this proxy only serves ${targetHost}\n`)
      return
    }
    try {
      const parsed = new URL(req.url!)
      req.url = parsed.pathname + parsed.search
    } catch { /* already origin-form */ }
    handleIntercepted(req, res, targetSecure).catch(() => res.destroy())
  })

  proxy.on('connect', (req, clientSocket, head) => {
    const [host, portStr] = req.url!.split(':')
    const port = Number(portStr || 443)

    if (host !== targetHost) {
      // blind tunnel: no certificate minted, no bytes inspected
      const upstream = net.connect(port, host, () => {
        clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
        if (head?.length) upstream.write(head)
        upstream.pipe(clientSocket)
        clientSocket.pipe(upstream)
      })
      upstream.on('error', () => clientSocket.destroy())
      clientSocket.on('error', () => upstream.destroy())
      return
    }

    clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
    if (head?.length) clientSocket.unshift(head)
    // hand the raw socket to the server that speaks what the client will send:
    // TLS (completing the handshake with a certificate minted for the SNI name)
    // for an https target, plain HTTP for an http one
    ;(targetSecure ? mitm : plainMitm).emit('connection', clientSocket)
  })

  await new Promise<void>(resolve => proxy.listen(opts.port, '127.0.0.1', resolve))
  const port = (proxy.address() as net.AddressInfo).port

  return {
    port,
    close: async () => {
      await new Promise<void>(resolve => proxy.close(() => resolve()))
      await new Promise<void>(resolve => mitm.close(() => resolve()))
      await new Promise<void>(resolve => plainMitm.close(() => resolve()))
    }
  }
}
