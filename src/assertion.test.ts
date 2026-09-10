import { test } from 'node:test'
import assert from 'node:assert'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createLocalJWKSet, jwtVerify, decodeProtectedHeader } from 'jose'
import { generateSigningKey, loadSigningKey, publicJwks } from './keys.ts'
import { mintAssertion, ASSERTION_LIFETIME_SEC } from './assertion.ts'

const setup = async () => {
  const dir = await mkdtemp(join(tmpdir(), 'nhi-'))
  const { publicJwks: jwks } = await generateSigningKey(dir)
  const { key, kid } = await loadSigningKey(dir)
  return { dir, jwks, key, kid }
}

test('the published JWKS is an ES256 P-256 public key with a kid', async () => {
  const { jwks } = await setup()
  const jwk = jwks.keys[0] as any
  assert.equal(jwk.kty, 'EC')
  assert.equal(jwk.crv, 'P-256')
  assert.equal(jwk.alg, 'ES256')
  assert.equal(jwk.use, 'sig')
  assert.ok(jwk.kid)
  assert.equal(jwk.d, undefined, 'the private component must never be published')
})

// this mirrors verifyAssertion in simple-directory api/src/nhis/service.ts exactly
test('an assertion verifies under simple-directory verification options', async () => {
  const { jwks, key, kid } = await setup()
  const assertion = await mintAssertion({
    key,
    kid,
    issuer: 'https://nhi-local.data-fair.cloud/9f3c1a',
    subject: 'alban@thinkpad',
    audience: 'https://koumoul.com'
  })
  assert.equal(decodeProtectedHeader(assertion).alg, 'ES256')
  const { payload } = await jwtVerify(assertion, createLocalJWKSet(jwks as any), {
    issuer: 'https://nhi-local.data-fair.cloud/9f3c1a',
    audience: 'https://koumoul.com',
    subject: 'alban@thinkpad',
    requiredClaims: ['exp', 'sub', 'iat']
  })
  assert.ok(payload.jti)
  const life = (payload.exp as number) - (payload.iat as number)
  assert.equal(life, ASSERTION_LIFETIME_SEC)
})

test('an assertion is rejected for the wrong audience and the wrong subject', async () => {
  const { jwks, key, kid } = await setup()
  const assertion = await mintAssertion({
    key, kid, issuer: 'https://iss.example.com', subject: 'sub-a', audience: 'https://koumoul.com'
  })
  const jwkSet = createLocalJWKSet(jwks as any)
  await assert.rejects(jwtVerify(assertion, jwkSet, {
    issuer: 'https://iss.example.com', audience: 'https://other.example.com', subject: 'sub-a'
  }))
  await assert.rejects(jwtVerify(assertion, jwkSet, {
    issuer: 'https://iss.example.com', audience: 'https://koumoul.com', subject: 'sub-b'
  }))
})

test('publicJwks reloads the same key material from disk', async () => {
  const { dir, jwks } = await setup()
  assert.deepEqual(await publicJwks(dir), jwks)
})
