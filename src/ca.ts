import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, randomBytes, X509Certificate, type KeyObject } from 'node:crypto'
import { readSecret, writeSecret } from './paths.ts'
import { caExtensions, createCertificate, leafExtensions, name, subjectOf } from './x509.ts'

export type CaBundle = {
  caCertPem: string
  caKeyPem: string
  leafKeyPem: string
  cache: Map<string, { cert: string, key: string }>
}

const serial = () => Buffer.concat([Buffer.from([0x01]), randomBytes(8)])

const newKey = () => generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey
// PKCS#1, as node-forge wrote them, so existing and new profiles look alike
const toPem = (key: KeyObject) => key.export({ type: 'pkcs1', format: 'pem' }) as string

export const generateCa = async (dir: string) => {
  const caKey = newKey()
  // one leaf keypair reused for every certificate, so the SPKI pin is stable
  const leafKey = newKey()

  const caName = name('nhi-proxy local CA')
  const ca = createCertificate({
    serial: serial(),
    issuer: caName,
    subject: caName,
    notBefore: new Date(Date.now() - 60_000),
    notAfter: new Date(Date.now() + 10 * 365 * 24 * 3600_000),
    publicKey: caKey,
    extensions: caExtensions
  }, caKey)

  await writeSecret(dir, 'ca.key', toPem(caKey))
  await writeSecret(dir, 'leaf.key', toPem(leafKey))
  // the CA certificate is public: tools must read it to trust the proxy
  await writeSecret(dir, 'ca.crt', ca)
}

export const loadCa = async (dir: string): Promise<CaBundle> => ({
  caCertPem: await readSecret(dir, 'ca.crt'),
  caKeyPem: await readSecret(dir, 'ca.key'),
  leafKeyPem: await readSecret(dir, 'leaf.key'),
  cache: new Map()
})

export const certForHost = (ca: CaBundle, hostname: string) => {
  const hit = ca.cache.get(hostname)
  if (hit) return hit

  const cert = createCertificate({
    serial: serial(),
    issuer: subjectOf(new X509Certificate(ca.caCertPem).raw),
    subject: name(hostname),
    notBefore: new Date(Date.now() - 60_000),
    notAfter: new Date(Date.now() + 397 * 24 * 3600_000),
    publicKey: createPrivateKey(ca.leafKeyPem),
    extensions: leafExtensions(hostname)
  }, createPrivateKey(ca.caKeyPem))

  const result = { cert, key: ca.leafKeyPem }
  ca.cache.set(hostname, result)
  return result
}

export const spkiPin = (ca: CaBundle) => {
  const der = createPublicKey(ca.leafKeyPem).export({ type: 'spki', format: 'der' })
  return createHash('sha256').update(der).digest('base64')
}
