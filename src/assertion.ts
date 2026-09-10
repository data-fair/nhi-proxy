import { SignJWT } from 'jose'
import type { CryptoKey } from 'jose'
import { randomUUID } from 'node:crypto'
import { ALG } from './keys.ts'

// Short on purpose: simple-directory caps the session at
// min(assertion.exp, now + 30m) and has no replay protection beyond exp, so a
// captured assertion is replayable only for this long.
export const ASSERTION_LIFETIME_SEC = 120

export const mintAssertion = async (opts: {
  key: CryptoKey,
  kid: string,
  issuer: string,
  subject: string,
  audience: string,
  lifetimeSec?: number
}) => {
  const now = Math.floor(Date.now() / 1000)
  // claims are exactly what verifyAssertion checks: iss/aud/sub matched, and
  // requiredClaims ['exp', 'sub', 'iat']
  return new SignJWT({})
    .setProtectedHeader({ alg: ALG, kid: opts.kid })
    .setIssuer(opts.issuer)
    .setSubject(opts.subject)
    .setAudience(opts.audience)
    .setIssuedAt(now)
    .setExpirationTime(now + (opts.lifetimeSec ?? ASSERTION_LIFETIME_SEC))
    .setJti(randomUUID())
    .sign(opts.key)
}
