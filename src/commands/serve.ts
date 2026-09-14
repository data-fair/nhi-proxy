import { join } from 'node:path'
import { configRoot, profileDir } from '../paths.ts'
import { readConfig } from '../config.ts'
import { loadSigningKey } from '../keys.ts'
import { loadCa, spkiPin } from '../ca.ts'
import { SessionHolder } from '../session.ts'
import { startProxy } from '../proxy.ts'
import { wiringHelp, hardeningHelp } from '../wiring.ts'
import { listProfiles, resolveProfile } from '../profiles.ts'

const SHUTDOWN_GRACE_MS = 3000

export const runServe = async (opts: { profile?: string, port?: number }) => {
  const profile = await resolveProfile(opts.profile)
  const config = await readConfig(profile)
  if (!config.clientId) {
    throw new Error(`profile "${profile}" is not enrolled yet — run \`nhi-proxy enroll <client_id> --profile ${profile}\` with the id your admin returned.`)
  }
  const dir = profileDir(profile)
  const { key, kid } = await loadSigningKey(dir)
  const ca = await loadCa(dir)
  const session = new SessionHolder({ config, key, kid })
  const targetUrl = new URL(config.site)
  const targetHost = targetUrl.hostname
  const port = opts.port ?? config.port
  let proxy
  try {
    proxy = await startProxy({
      port,
      targetHost,
      targetSecure: targetUrl.protocol === 'https:',
      targetPort: targetUrl.port ? Number(targetUrl.port) : undefined,
      ca,
      session
    })
  } catch (err: any) {
    // the common one by far: another profile already serving, or a leftover
    // proxy from a previous run. A raw EADDRINUSE stack says none of that.
    if (err?.code === 'EADDRINUSE') {
      const others = (await listProfiles()).filter(p => p.name !== profile && p.config.port === port)
      throw new Error(
        `port ${port} is already in use, so profile "${profile}" cannot serve.\n` +
        (others.length
          ? `  profile "${others[0].name}" is configured for the same port — one of them needs a different one.\n`
          : '  another process is on it — possibly a proxy left over from an earlier run.\n') +
        `  Try \`nhi-proxy serve --profile ${profile} --port <n>\` for a one-off, or set it for good with \`nhi-proxy setup --rotate --profile ${profile} --port <n>\`.`
      )
    }
    throw err
  }

  const caPath = join(dir, 'ca.crt')
  const pin = spkiPin(ca)
  console.log(`nhi-proxy proxying ${targetHost} on http://127.0.0.1:${proxy.port} as ${config.clientId}`)
  console.log(`  profile   ${profile}`)
  console.log(`  CA        ${caPath}`)
  console.log(`  SPKI pin  ${pin}`)
  console.log('Every other host is tunnelled untouched.')
  console.log(wiringHelp({
    port: proxy.port,
    targetHost: targetUrl.host,
    secure: targetUrl.protocol === 'https:',
    caPath,
    spkiPin: pin,
    sdPath: config.sdPath
  }))
  console.log(hardeningHelp(configRoot()))

  // Tracking sockets makes close() return promptly, but a shutdown must never
  // be able to leave the daemon alive on a bound port whatever the cause, so
  // the exit is also guarded: a second Ctrl+C goes immediately, and the timer
  // covers the case where nobody is there to press it.
  let shuttingDown = false
  const shutdown = () => {
    if (shuttingDown) process.exit(1)
    shuttingDown = true
    setTimeout(() => {
      console.error(`nhi-proxy: shutdown did not complete within ${SHUTDOWN_GRACE_MS}ms, exiting anyway`)
      process.exit(1)
    }, SHUTDOWN_GRACE_MS).unref()
    proxy.close().then(() => process.exit(0), () => process.exit(1))
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
}
