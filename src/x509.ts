// Just enough DER to mint the proxy's certificates with node:crypto doing the
// signing. Vendored in place of node-forge: node can parse X.509 but not build
// it, and the certificates here have one fixed shape.
import { sign, createPublicKey, type KeyObject } from 'node:crypto'

const len = (n: number) => {
  if (n < 0x80) return Buffer.from([n])
  const bytes: number[] = []
  for (; n > 0; n >>= 8) bytes.unshift(n & 0xff)
  return Buffer.from([0x80 | bytes.length, ...bytes])
}
const tlv = (tag: number, ...content: Buffer[]) => {
  const body = Buffer.concat(content)
  return Buffer.concat([Buffer.from([tag]), len(body.length), body])
}

const seq = (...items: Buffer[]) => tlv(0x30, ...items)
const set = (...items: Buffer[]) => tlv(0x31, ...items)
const bool = (v: boolean) => tlv(0x01, Buffer.from([v ? 0xff : 0x00]))
const int = (bytes: Buffer) => tlv(0x02, bytes)
const bitString = (unused: number, bytes: Buffer) => tlv(0x03, Buffer.from([unused]), bytes)
const octetString = (bytes: Buffer) => tlv(0x04, bytes)
const nul = () => tlv(0x05)
const oid = (dotted: string) => {
  const [a, b, ...rest] = dotted.split('.').map(Number)
  const out = [40 * a + b]
  for (const arc of rest) {
    const chunk = [arc & 0x7f]
    for (let v = arc >> 7; v > 0; v >>= 7) chunk.unshift(0x80 | (v & 0x7f))
    out.push(...chunk)
  }
  return tlv(0x06, Buffer.from(out))
}
const utf8 = (s: string) => tlv(0x0c, Buffer.from(s, 'utf8'))
// RFC 5280: UTCTime through 2049, GeneralizedTime after
const time = (d: Date) => {
  const iso = d.toISOString().replace(/[-:T]/g, '').slice(0, 14) + 'Z'
  return d.getUTCFullYear() < 2050 ? tlv(0x17, Buffer.from(iso.slice(2))) : tlv(0x18, Buffer.from(iso))
}
const explicit = (n: number, inner: Buffer) => tlv(0xa0 | n, inner)

const sha256WithRSA = seq(oid('1.2.840.113549.1.1.11'), nul())

export const name = (commonName: string) => seq(set(seq(oid('2.5.4.3'), utf8(commonName))))

const ext = (id: string, critical: boolean, value: Buffer) =>
  seq(oid(id), ...(critical ? [bool(true)] : []), octetString(value))

export const caExtensions = [
  ext('2.5.29.19', true, seq(bool(true))), // basicConstraints cA
  ext('2.5.29.15', true, bitString(1, Buffer.from([0x06]))) // keyUsage keyCertSign, cRLSign
]

export const leafExtensions = (hostname: string) => [
  ext('2.5.29.19', true, seq()), // basicConstraints, not a CA
  ext('2.5.29.15', true, bitString(5, Buffer.from([0xa0]))), // keyUsage digitalSignature, keyEncipherment
  ext('2.5.29.37', false, seq(oid('1.3.6.1.5.5.7.3.1'))), // extKeyUsage serverAuth
  ext('2.5.29.17', false, seq(tlv(0x82, Buffer.from(hostname, 'ascii')))) // subjectAltName dNSName
]

export type CertSpec = {
  serial: Buffer
  issuer: Buffer
  subject: Buffer
  notBefore: Date
  notAfter: Date
  publicKey: KeyObject
  extensions: Buffer[]
}

export const createCertificate = (spec: CertSpec, signingKey: KeyObject) => {
  const tbs = seq(
    explicit(0, int(Buffer.from([0x02]))), // v3
    int(spec.serial),
    sha256WithRSA,
    spec.issuer,
    seq(time(spec.notBefore), time(spec.notAfter)),
    spec.subject,
    createPublicKey(spec.publicKey).export({ type: 'spki', format: 'der' }),
    explicit(3, seq(...spec.extensions))
  )
  const der = seq(tbs, sha256WithRSA, bitString(0, sign('sha256', tbs, signingKey)))
  return `-----BEGIN CERTIFICATE-----\n${der.toString('base64').match(/.{1,64}/g)!.join('\n')}\n-----END CERTIFICATE-----\n`
}

// [start, end) of the element at `at`, and where its content begins
const read = (der: Buffer, at: number) => {
  let n = der[at + 1]
  let header = 2
  if (n & 0x80) {
    const count = n & 0x7f
    n = 0
    for (let i = 0; i < count; i++) n = (n << 8) | der[at + 2 + i]
    header += count
  }
  return { content: at + header, end: at + header + n }
}

// The subject exactly as encoded in `certDer`, to reuse verbatim as an issuer:
// chain building compares names, and a CA made by an earlier version (node-forge,
// PrintableString) must keep matching.
export const subjectOf = (certDer: Buffer) => {
  let at = read(certDer, 0).content // into Certificate
  at = read(certDer, at).content // into TBSCertificate
  if (certDer[at] === 0xa0) at = read(certDer, at).end // optional version
  for (let i = 0; i < 4; i++) at = read(certDer, at).end // serial, signature, issuer, validity
  return certDer.subarray(at, read(certDer, at).end)
}
