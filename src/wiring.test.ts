import { test } from 'node:test'
import assert from 'node:assert'
import { curlExample, playwrightMcpConfig, wiringHelp, hardeningHelp, tildify, type Wiring } from './wiring.ts'

const https: Wiring = {
  port: 7332,
  targetHost: 'koumoul.com',
  secure: true,
  caPath: '/home/alban/.config/nhi-proxy/dev/ca.crt',
  spkiPin: 'PIN=',
  sdPath: '/simple-directory'
}
const http: Wiring = { ...https, port: 7331, targetHost: 'localhost:5690', secure: false }

test('the curl example carries the real port and CA path', () => {
  const c = curlExample(https)
  assert.match(c, /--proxy http:\/\/127\.0\.0\.1:7332/)
  assert.match(c, /--cacert \/home\/alban\/\.config\/nhi-proxy\/dev\/ca\.crt/)
  assert.match(c, /https:\/\/koumoul\.com\/simple-directory\/api\/auth\/me/)
})

// the two failure modes that look like bugs in nhi-proxy rather than in the
// command: a missing CA, and curl silently bypassing the proxy for localhost
test('a plain-http target drops --cacert and adds --noproxy', () => {
  const c = curlExample(http)
  assert.doesNotMatch(c, /--cacert/)
  assert.match(c, /--noproxy ''/)
  assert.match(c, /http:\/\/localhost:5690\/simple-directory\/api\/auth\/me/)
})

test('the playwright config pins the SPKI and points at the proxy', () => {
  const parsed = JSON.parse(playwrightMcpConfig(https))
  assert.equal(parsed.browser.launchOptions.proxy.server, 'http://127.0.0.1:7332')
  assert.deepEqual(parsed.browser.launchOptions.args, ['--ignore-certificate-errors-spki-list=PIN='])
})

test('the help mentions the CA only when the target uses TLS', () => {
  assert.match(wiringHelp(https), /NODE_EXTRA_CA_CERTS/)
  assert.doesNotMatch(wiringHelp(http), /NODE_EXTRA_CA_CERTS/)
})

test('the hardening advice carries the real config root, tilde-shortened', () => {
  const help = hardeningHelp('/home/alban/.config/nhi-proxy')
  assert.match(help, /Read\(~\/\.config\/nhi-proxy\/\*\*\)/)
  assert.match(help, /"path": "~\/\.config\/nhi-proxy"/)
  assert.match(help, /"~\/\.config\/nhi-proxy\/\*": "deny"/)
  // the caveat must travel with the advice, or it overpromises
  assert.match(help, /Neither stops a process running as you/)
})

test('a config root outside HOME is printed verbatim', () => {
  assert.match(hardeningHelp('/var/lib/nhi-proxy/.config/nhi-proxy'), /\/var\/lib\/nhi-proxy/)
})

test('tildify only shortens paths actually under HOME', () => {
  assert.equal(tildify('/home/alban/.config/x', '/home/alban'), '~/.config/x')
  assert.equal(tildify('/home/alban-other/.config/x', '/home/alban'), '/home/alban-other/.config/x')
  assert.equal(tildify('/etc/x', '/home/alban'), '/etc/x')
})
