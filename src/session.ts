import type { CryptoKey } from 'jose'
import { mintAssertion } from './assertion.ts'
import { cookieHeaderFromSetCookie } from './cookies.ts'
import { diagnose } from './diagnose.ts'
import type { NhiLocalConfig } from './config.ts'

// Upper bound on how far ahead of expiry we refresh. It is only ever a cap:
// the effective margin is derived per exchange from the session actually
// granted (see #refreshMarginMs). A fixed margin was the original bug — at 300s
// against the ~120s session simple-directory really returns, no session was
// ever "fresh", so every proxied request triggered an exchange and the auth
// limiter tripped within one page load.
export const REFRESH_MARGIN_SEC = 300

// Refresh once a third of the session is left. Relative rather than absolute so
// the proxy cannot assume a lifetime it was not given: an operator running with
// a smaller jwtDurations.nhiToken must not resurrect the refresh loop.
const REFRESH_AT_FRACTION = 3

// simple-directory's auth limiter is 5 points per 60s, so 60s is exactly long
// enough for the bucket to refill. Used when a failure carries no Retry-After.
const RETRY_BACKOFF_MS = 60_000

export class SessionHolder {
  #config: NhiLocalConfig
  #key: CryptoKey
  #kid: string
  #cookieHeader: string | null = null
  #setCookie: string[] = []
  #expiresAt: number | null = null
  #refreshMarginMs: number = REFRESH_MARGIN_SEC * 1000
  #retryAt: number | null = null
  #inFlight: Promise<string> | null = null
  #lastError: string | null = null

  constructor (opts: { config: NhiLocalConfig, key: CryptoKey, kid: string }) {
    this.#config = opts.config
    this.#key = opts.key
    this.#kid = opts.kid
  }

  get state () {
    return {
      expiresAt: this.#expiresAt,
      lastError: this.#lastError,
      refreshMarginMs: this.#refreshMarginMs,
      retryAt: this.#retryAt
    }
  }

  /**
   * The exchange's Set-Cookie headers, verbatim. The proxy relays these to the
   * client: the data-fair SPA reads its session from `document.cookie`, so a
   * browser whose jar never receives them renders as anonymous even though
   * every request it makes is authenticated. Replaying the raw headers keeps
   * simple-directory's own attributes — notably that `id_token` is readable by
   * the SPA while `id_token_sign` is httpOnly.
   */
  get setCookie () {
    return this.#setCookie
  }

  invalidate () {
    this.#cookieHeader = null
    this.#setCookie = []
    this.#expiresAt = null
  }

  async cookieHeader (): Promise<string> {
    const remainingMs = this.#expiresAt ? this.#expiresAt - Date.now() : 0
    if (this.#cookieHeader && remainingMs > this.#refreshMarginMs) return this.#cookieHeader

    // A failed exchange spends a limiter point too, so retrying on every
    // request keeps the bucket empty for as long as traffic keeps arriving —
    // the spiral that turned one 429 into a wall of 502s. Back off instead, and
    // keep serving the held session if it has not actually expired yet: a
    // session with seconds left still works, and a 502 in its place is a
    // self-inflicted outage.
    if (this.#retryAt && Date.now() < this.#retryAt) {
      if (this.#cookieHeader && remainingMs > 0) return this.#cookieHeader
      const waitSec = Math.ceil((this.#retryAt - Date.now()) / 1000)
      throw new Error(`${this.#lastError ?? 'the last session exchange failed'}\n  (not retrying for another ${waitSec}s, to let the limiter recover)`)
    }

    // every concurrent caller awaits the same exchange: the auth rate limiter
    // consumes a point per successful call, so a parallel burst must be one call
    this.#inFlight ??= this.#exchange().finally(() => { this.#inFlight = null })
    try {
      return await this.#inFlight
    } catch (err) {
      // same reasoning as the backoff branch, for the request that hits the
      // failure rather than the ones behind it: a refresh that fails does not
      // make the session we already hold stop working
      if (this.#cookieHeader && this.#expiresAt && this.#expiresAt > Date.now()) return this.#cookieHeader
      throw err
    }
  }

  #backOff (retryAfterHeader: string | null) {
    const retryAfterSec = Number(retryAfterHeader)
    // Retry-After may also be an HTTP-date, which is not a finite number; the
    // default covers that as well as its absence
    this.#retryAt = Date.now() + (Number.isFinite(retryAfterSec) && retryAfterSec > 0
      ? retryAfterSec * 1000
      : RETRY_BACKOFF_MS)
  }

  async #exchange (): Promise<string> {
    const { site, sdPath, clientId, issuer, subject } = this.#config
    const assertion = await mintAssertion({
      key: this.#key,
      kid: this.#kid,
      issuer,
      subject,
      // the audience is the site origin, never the simple-directory URL
      audience: site
    })
    const url = `${site}${sdPath}/api/auth/nhi-token`
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ client_id: clientId, assertion })
    })

    if (!res.ok) {
      const message = diagnose({
        status: res.status,
        dateHeader: res.headers.get('date') ?? undefined,
        site,
        clientId
      })
      this.#lastError = message
      this.#backOff(res.headers.get('retry-after'))
      throw new Error(message)
    }

    const setCookie = res.headers.getSetCookie()
    const header = cookieHeaderFromSetCookie(setCookie)
    if (!header) {
      const message = `Exchange with ${site} succeeded but set no session cookies — the deployment may sit behind a proxy that strips Set-Cookie.`
      this.#lastError = message
      this.#backOff(null)
      throw new Error(message)
    }
    const body = await res.json() as { expires_in?: number }
    const expiresIn = body.expires_in ?? 1800

    this.#cookieHeader = header
    this.#setCookie = setCookie
    this.#expiresAt = Date.now() + expiresIn * 1000
    this.#refreshMarginMs = Math.min(REFRESH_MARGIN_SEC * 1000, (expiresIn * 1000) / REFRESH_AT_FRACTION)
    this.#retryAt = null
    this.#lastError = null
    return header
  }
}
