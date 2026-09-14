// The exchange response's Set-Cookie headers are replayed verbatim rather than
// rebuilt from the body's access_token: simple-directory splits the JWT across
// id_token (header.payload) and id_token_sign (signature), and also sets
// id_token_org/_dep/_role. Replaying avoids reimplementing any of that.
const isDeletion = (attrs: string[], value: string) => {
  if (value !== '') return false
  return attrs.some(a => {
    const [k, v] = a.split('=')
    if (k.trim().toLowerCase() === 'max-age') return Number(v) <= 0
    if (k.trim().toLowerCase() === 'expires') return new Date(v).getTime() <= Date.now()
    return false
  })
}

export const cookieHeaderFromSetCookie = (setCookie: string[]) => {
  const pairs: string[] = []
  for (const raw of setCookie) {
    const [pair, ...attrs] = raw.split(';')
    const eq = pair.indexOf('=')
    if (eq === -1) continue
    const name = pair.slice(0, eq).trim()
    const value = pair.slice(eq + 1).trim()
    // simple-directory clears id_token_dep / id_token_role by setting them
    // empty with a 1970 expiry; replaying those as live cookies would be wrong
    if (isDeletion(attrs, value)) continue
    pairs.push(`${name}=${value}`)
  }
  return pairs.join('; ')
}

export const mergeCookieHeader = (existing: string | undefined, injected: string) => {
  if (!existing) return injected
  const injectedNames = new Set(
    injected.split(';').map(p => p.split('=')[0].trim())
  )
  const kept = existing
    .split(';')
    .map(p => p.trim())
    .filter(p => p && !injectedNames.has(p.split('=')[0].trim()))
  return [...kept, injected].join('; ')
}

const parseJar = (header: string | undefined) => {
  const jar = new Map<string, string>()
  for (const part of (header ?? '').split(';')) {
    const eq = part.indexOf('=')
    if (eq === -1) continue
    jar.set(part.slice(0, eq).trim(), part.slice(eq + 1).trim())
  }
  return jar
}

/**
 * Whether the client's own jar disagrees with the session being injected, and
 * so needs the exchange's Set-Cookie relayed back to it.
 *
 * Injecting cookies into the upstream request authenticates the request but
 * leaves the client's jar empty, which is invisible to curl and fatal to a SPA:
 * `@data-fair/lib-vue` treats `document.cookie` as the source of truth for the
 * session, so data-fair renders as anonymous while every call it makes is
 * authenticated.
 *
 * Answering from the request, rather than relaying once per exchange, keeps
 * each client correct independently: a second browser context or a cleared jar
 * resyncs on its next response instead of waiting for an exchange that some
 * other client already consumed.
 */
export const clientNeedsSessionCookies = (clientCookie: string | undefined, sessionCookie: string) => {
  const jar = parseJar(clientCookie)
  for (const [name, value] of parseJar(sessionCookie)) {
    if (jar.get(name) !== value) return true
  }
  return false
}
