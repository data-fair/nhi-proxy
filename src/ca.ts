import forge from 'node-forge'
import { createHash } from 'node:crypto'
import { readSecret, writeSecret } from './paths.ts'

export type CaBundle = {
  caCertPem: string
  caKeyPem: string
  leafKeyPem: string
  cache: Map<string, { cert: string, key: string }>
}

const serial = () => '01' + forge.util.bytesToHex(forge.random.getBytesSync(8))

export const generateCa = async (dir: string) => {
  const caKeys = forge.pki.rsa.generateKeyPair(2048)
  // one leaf keypair reused for every certificate, so the SPKI pin is stable
  const leafKeys = forge.pki.rsa.generateKeyPair(2048)

  const ca = forge.pki.createCertificate()
  ca.publicKey = caKeys.publicKey
  ca.serialNumber = serial()
  ca.validity.notBefore = new Date(Date.now() - 60_000)
  ca.validity.notAfter = new Date(Date.now() + 10 * 365 * 24 * 3600_000)
  const caName = [{ name: 'commonName', value: 'nhi-local local CA' }]
  ca.setSubject(caName)
  ca.setIssuer(caName)
  ca.setExtensions([
    { name: 'basicConstraints', cA: true, critical: true },
    { name: 'keyUsage', keyCertSign: true, cRLSign: true, critical: true }
  ])
  ca.sign(caKeys.privateKey, forge.md.sha256.create())

  await writeSecret(dir, 'ca.key', forge.pki.privateKeyToPem(caKeys.privateKey))
  await writeSecret(dir, 'leaf.key', forge.pki.privateKeyToPem(leafKeys.privateKey))
  // the CA certificate is public: tools must read it to trust the proxy
  await writeSecret(dir, 'ca.crt', forge.pki.certificateToPem(ca))
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

  const caCert = forge.pki.certificateFromPem(ca.caCertPem)
  const caKey = forge.pki.privateKeyFromPem(ca.caKeyPem)
  const leafKey = forge.pki.privateKeyFromPem(ca.leafKeyPem)

  const cert = forge.pki.createCertificate()
  cert.publicKey = forge.pki.setRsaPublicKey(leafKey.n, leafKey.e)
  cert.serialNumber = serial()
  cert.validity.notBefore = new Date(Date.now() - 60_000)
  cert.validity.notAfter = new Date(Date.now() + 397 * 24 * 3600_000)
  cert.setSubject([{ name: 'commonName', value: hostname }])
  cert.setIssuer(caCert.subject.attributes)
  cert.setExtensions([
    { name: 'basicConstraints', cA: false, critical: true },
    { name: 'keyUsage', digitalSignature: true, keyEncipherment: true, critical: true },
    { name: 'extKeyUsage', serverAuth: true },
    // type 2 = dNSName
    { name: 'subjectAltName', altNames: [{ type: 2, value: hostname }] }
  ])
  cert.sign(caKey, forge.md.sha256.create())

  const result = { cert: forge.pki.certificateToPem(cert), key: ca.leafKeyPem }
  ca.cache.set(hostname, result)
  return result
}

export const spkiPin = (ca: CaBundle) => {
  const leafKey = forge.pki.privateKeyFromPem(ca.leafKeyPem)
  const pub = forge.pki.setRsaPublicKey(leafKey.n, leafKey.e)
  const der = forge.asn1.toDer(forge.pki.publicKeyToAsn1(pub)).getBytes()
  return createHash('sha256').update(Buffer.from(der, 'binary')).digest('base64')
}
