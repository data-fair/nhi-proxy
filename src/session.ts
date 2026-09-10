import type { CryptoKey } from 'jose'
import { mintAssertion } from './assertion.ts'
import { cookieHeaderFromSetCookie } from './cookies.ts'
import { diagnose } from './diagnose.ts'
import type { NhiLocalConfig } from './config.ts'

// refresh this far ahead of expiry; the session is capped at 30 minutes by
// simple-directory and cannot be renewed, only replaced
export const REFRESH_MARGIN_SEC = 300

export class SessionHolder {
  #config: NhiLocalConfig
  #key: CryptoKey
  #kid: string
  #cookieHeader: string | null = null
  #expiresAt: number | null = null
  #inFlight: Promise<string> | null = null
  #lastError: string | null = null

  constructor (opts: { config: NhiLocalConfig, key: CryptoKey, kid: string }) {
    this.#config = opts.config
    this.#key = opts.key
    this.#kid = opts.kid
  }

  get state () {
    return { expiresAt: this.#expiresAt, lastError: this.#lastError }
  }

  invalidate () {
    this.#cookieHeader = null
    this.#expiresAt = null
  }

  async cookieHeader (): Promise<string> {
    const fresh = this.#cookieHeader &&
      this.#expiresAt && this.#expiresAt - Date.now() > REFRESH_MARGIN_SEC * 1000
    if (fresh) return this.#cookieHeader as string
    // every concurrent caller awaits the same exchange: the auth rate limiter
    // consumes a point per successful call, so a parallel burst must be one call
    this.#inFlight ??= this.#exchange().finally(() => { this.#inFlight = null })
    return this.#inFlight
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
      throw new Error(message)
    }

    const setCookie = res.headers.getSetCookie()
    const header = cookieHeaderFromSetCookie(setCookie)
    if (!header) {
      const message = `Exchange with ${site} succeeded but set no session cookies — the deployment may sit behind a proxy that strips Set-Cookie.`
      this.#lastError = message
      throw new Error(message)
    }
    const body = await res.json() as { expires_in?: number }
    const expiresIn = body.expires_in ?? 1800

    this.#cookieHeader = header
    this.#expiresAt = Date.now() + expiresIn * 1000
    this.#lastError = null
    return header
  }
}
