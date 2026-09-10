import { generateKeyPair, exportJWK, importJWK, calculateJwkThumbprint } from 'jose'
import type { CryptoKey } from 'jose'
import { readSecret, writeSecret } from './paths.ts'

// ES256 rather than Ed25519 on purpose: simple-directory runs jose 4, where an
// Ed25519 key must be signed as `EdDSA`, while jose 5/6 also accept `Ed25519`.
// A mismatch surfaces only as the exchange endpoint's uniform 401. ES256 is
// spelled identically across every jose major.
export const ALG = 'ES256'

export const generateSigningKey = async (dir: string) => {
  const { privateKey, publicKey } = await generateKeyPair(ALG, { extractable: true })
  const privateJwk = await exportJWK(privateKey)
  const publicJwk = await exportJWK(publicKey)
  const kid = await calculateJwkThumbprint(publicJwk)
  await writeSecret(dir, 'key.jwk', JSON.stringify({ ...privateJwk, kid, alg: ALG, use: 'sig' }))
  return { publicJwks: { keys: [{ ...publicJwk, kid, alg: ALG, use: 'sig' }] }, kid }
}

const privateJwk = async (dir: string) => JSON.parse(await readSecret(dir, 'key.jwk'))

export const loadSigningKey = async (dir: string) => {
  const jwk = await privateJwk(dir)
  return { key: await importJWK(jwk, ALG) as CryptoKey, kid: jwk.kid as string }
}

export const publicJwks = async (dir: string) => {
  const { d, ...pub } = await privateJwk(dir)
  return { keys: [pub] }
}
