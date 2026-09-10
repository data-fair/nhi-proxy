import { hostname, userInfo } from 'node:os'
import { randomBytes } from 'node:crypto'
import { createInterface } from 'node:readline/promises'
import { ensureProfileDir, profileDir } from '../paths.ts'
import { writeConfig, readConfig } from '../config.ts'
import { generateSigningKey, publicJwks } from '../keys.ts'
import { generateCa } from '../ca.ts'
import { listProfiles, profileNameForSite, nextFreePort } from '../profiles.ts'

export const DEFAULT_SITE = 'https://koumoul.com'

export type SetupOptions = {
  site?: string
  profile?: string
  subject?: string
  sdPath?: string
  port?: number
  rotate?: boolean
}

export const runSetup = async (opts: SetupOptions) => {
  const url = new URL(opts.site ?? DEFAULT_SITE)
  // the assertion audience is reqOrigin + reqSitePath; a site with a path here
  // is almost always someone pasting the simple-directory URL by mistake
  if (url.pathname !== '/' && url.pathname !== '') {
    throw new Error(`--site must be the platform origin (e.g. ${url.origin}), not a URL with a path. simple-directory's own mount path goes in --sd-path.`)
  }
  const site = url.origin
  const profile = opts.profile ?? profileNameForSite(site)

  const existing = (await listProfiles()).find(p => p.name === profile)
  if (existing && !opts.rotate) {
    throw new Error(`profile "${profile}" already exists (${existing.config.site}). Use --rotate to replace its key, or --profile <name> for a separate one.`)
  }
  const previous = existing ? await readConfig(profile) : null

  const dir = await ensureProfileDir(profile)
  await generateSigningKey(dir)
  // the CA is the trust anchor already installed in the user's tools; rotating
  // the signing key must not invalidate every tool config on the machine
  if (!previous) await generateCa(dir)

  await writeConfig(profile, {
    site,
    sdPath: opts.sdPath ?? previous?.sdPath ?? '/simple-directory',
    // the client_id survives a rotation: the admin re-pastes the JWKS onto the
    // same NHI rather than creating a new one
    clientId: previous?.clientId,
    issuer: previous?.issuer ?? `https://nhi-local.data-fair.cloud/${randomBytes(4).toString('hex')}`,
    subject: opts.subject ?? previous?.subject ?? `${userInfo().username}@${hostname()}`,
    port: opts.port ?? previous?.port ?? await nextFreePort()
  })

  const config = await readConfig(profile)
  return {
    profile,
    issuer: config.issuer,
    subject: config.subject,
    site: config.site,
    port: config.port,
    jwks: await publicJwks(dir),
    rotated: !!previous
  }
}

export const printAdminBlock = (out: Awaited<ReturnType<typeof runSetup>>) => {
  const action = out.rotated
    ? 'Your key was rotated. Ask an admin to update the existing NHI with the new JWKS:'
    : 'Send this to an admin of your organization. Nothing in it is secret:'
  console.log(`\n${action}\n`)
  console.log('  ┌───────────────────────────────────────────────────────────────')
  console.log(`  │ In ${out.site}, open your organization's page,`)
  console.log('  │ then "Non-human identities" → add, and fill in:')
  console.log('  │')
  console.log(`  │   issuer   ${out.issuer}`)
  console.log(`  │   subject  ${out.subject}`)
  console.log(`  │   jwks     ${JSON.stringify(out.jwks)}`)
  console.log('  │')
  console.log('  │ Then send me back the generated id (it looks like nhi-XXXXXXXXXX).')
  console.log('  └───────────────────────────────────────────────────────────────')
}

/** interactive wizard; falls back to flags alone when stdin is not a TTY */
export const runSetupWizard = async (opts: SetupOptions) => {
  const interactive = !!process.stdin.isTTY && !!process.stdout.isTTY
  let options = opts

  if (interactive && !opts.site) {
    const rl = createInterface({ input: process.stdin, output: process.stdout })
    try {
      const site = (await rl.question(`Platform URL [${DEFAULT_SITE}]: `)).trim() || DEFAULT_SITE
      const defaultName = profileNameForSite(new URL(site).origin)
      const profile = (await rl.question(`Profile name [${defaultName}]: `)).trim() || defaultName
      const defaultSubject = `${userInfo().username}@${hostname()}`
      const subject = (await rl.question(`Subject (identifies this machine) [${defaultSubject}]: `)).trim() || defaultSubject
      options = { ...opts, site, profile, subject }
    } finally {
      rl.close()
    }
  }

  const out = await runSetup(options)
  console.log(`\nProfile "${out.profile}" created at ${profileDir(out.profile)}`)
  printAdminBlock(out)

  if (!interactive) {
    console.log(`\nWhen your admin returns the id:  nhi-local enroll <client_id> --profile ${out.profile}`)
    return out
  }

  const rl = createInterface({ input: process.stdin, output: process.stdout })
  try {
    // Ctrl-C here is safe and expected: the profile is already on disk
    console.log('\nPaste the id when you have it, or press Ctrl-C and finish later with:')
    console.log(`  nhi-local enroll <client_id> --profile ${out.profile}\n`)
    const clientId = (await rl.question('client_id: ')).trim()
    if (clientId) {
      const { runEnroll } = await import('./enroll.ts')
      await runEnroll(clientId, out.profile)
    }
  } finally {
    rl.close()
  }
  return out
}
