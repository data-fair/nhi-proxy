/**
 * The wiring recipes `serve` prints. Kept pure so they can be tested: these
 * strings are what users copy, and getting the port or the CA path wrong in
 * them wastes more time than the proxy saves.
 */
export type Wiring = {
  port: number
  targetHost: string
  secure: boolean
  caPath: string
  spkiPin: string
  sdPath: string
}

const indent = (text: string) => text.split('\n').map(l => '  ' + l).join('\n')

export const curlExample = (w: Wiring) => {
  const proxy = `http://127.0.0.1:${w.port}`
  const url = `${w.secure ? 'https' : 'http'}://${w.targetHost}${w.sdPath}/api/auth/me`
  return w.secure
    ? `curl --proxy ${proxy} \\\n     --cacert ${w.caPath} \\\n     ${url}`
    // plain http: no TLS to intercept, but curl skips the proxy for localhost
    // whenever no_proxy is set, and then quietly answers anonymously
    : `curl --proxy ${proxy} --noproxy '' \\\n     ${url}`
}

export const playwrightMcpConfig = (w: Wiring) => JSON.stringify({
  browser: {
    launchOptions: {
      proxy: { server: `http://127.0.0.1:${w.port}` },
      args: [`--ignore-certificate-errors-spki-list=${w.spkiPin}`]
    }
  }
}, null, 2)

/** display a path under $HOME as ~/... so the snippets are paste-ready */
export const tildify = (path: string, home = process.env.HOME) =>
  home && path.startsWith(home + '/') ? '~' + path.slice(home.length) : path

/**
 * Printed on every `serve`. It is advice, not enforcement — nhi-proxy never
 * edits configuration it does not own — but the paths have to be exact, and a
 * reader who has just started the proxy is the one who will act on it.
 */
export const hardeningHelp = (configRoot: string) => {
  const root = tildify(configRoot)
  return [
    '',
    'Keep the signing key out of your agent\'s reach — details in docs/security.md:',
    '  Claude Code  ~/.claude/settings.json',
    `    { "permissions": { "deny": ["Read(${root}/**)"] },`,
    `      "sandbox": { "credentials": { "files": [{ "path": "${root}", "mode": "deny" }] } } }`,
    '  opencode     ~/.config/opencode/opencode.json',
    `    { "permission": { "read": { "*": "allow", "${root}/*": "deny" } } }`,
    '  Neither stops a process running as you — including this proxy\'s own port.'
  ].join('\n')
}

export const wiringHelp = (w: Wiring) => [
  '',
  'Check it with curl — this request carries no credential of its own:',
  indent(curlExample(w)),
  '',
  'Playwright MCP — save as playwright-mcp.json and pass --config:',
  indent(playwrightMcpConfig(w)),
  '',
  `Other tools: HTTPS_PROXY=http://127.0.0.1:${w.port}` +
    (w.secure ? ` NODE_EXTRA_CA_CERTS=${w.caPath}` : '')
].join('\n')
