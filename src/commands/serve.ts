import { profileDir } from '../paths.ts'
import { readConfig } from '../config.ts'
import { loadSigningKey } from '../keys.ts'
import { loadCa, spkiPin } from '../ca.ts'
import { SessionHolder } from '../session.ts'
import { startProxy } from '../proxy.ts'
import { resolveProfile } from '../profiles.ts'

export const runServe = async (opts: { profile?: string, port?: number }) => {
  const profile = await resolveProfile(opts.profile)
  const config = await readConfig(profile)
  if (!config.clientId) {
    throw new Error(`profile "${profile}" is not enrolled yet — run \`nhi-local enroll <client_id> --profile ${profile}\` with the id your admin returned.`)
  }
  const dir = profileDir(profile)
  const { key, kid } = await loadSigningKey(dir)
  const ca = await loadCa(dir)
  const session = new SessionHolder({ config, key, kid })
  const targetUrl = new URL(config.site)
  const targetHost = targetUrl.hostname
  const proxy = await startProxy({
    port: opts.port ?? config.port,
    targetHost,
    targetSecure: targetUrl.protocol === 'https:',
    targetPort: targetUrl.port ? Number(targetUrl.port) : undefined,
    ca,
    session
  })

  console.log(`nhi-local proxying ${targetHost} on http://127.0.0.1:${proxy.port}`)
  console.log(`  profile   ${profile}`)
  console.log(`  CA        ${dir}/ca.crt`)
  console.log(`  SPKI pin  ${spkiPin(ca)}`)
  console.log('Every other host is tunnelled untouched.')

  const shutdown = () => { proxy.close().then(() => process.exit(0), () => process.exit(1)) }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
}
