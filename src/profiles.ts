import { readdir } from 'node:fs/promises'
import { createServer } from 'node:net'
import { configRoot, profileDir } from './paths.ts'
import { readConfig, type NhiLocalConfig } from './config.ts'

export type ProfileSummary = { name: string, dir: string, config: NhiLocalConfig }

/** thrown when nothing is configured yet, so bare `nhi-proxy` can run setup */
export class NoProfilesError extends Error {
  constructor () { super('no nhi-proxy profile configured yet') }
}

// The filesystem is the profile list: a profile is any subdirectory holding a
// config.json. No registry file to fall out of sync, and `rm -r` is a complete
// uninstall of one profile.
export const listProfiles = async (): Promise<ProfileSummary[]> => {
  let entries
  try {
    entries = await readdir(configRoot(), { withFileTypes: true })
  } catch (err: any) {
    if (err.code === 'ENOENT') return []
    throw err
  }
  const found: ProfileSummary[] = []
  for (const entry of entries.filter(e => e.isDirectory())) {
    try {
      found.push({ name: entry.name, dir: profileDir(entry.name), config: await readConfig(entry.name) })
    } catch {
      // a directory without a readable config.json simply is not a profile
    }
  }
  return found.sort((a, b) => a.name.localeCompare(b.name))
}

export const resolveProfile = async (explicit?: string): Promise<string> => {
  const profiles = await listProfiles()
  const names = profiles.map(p => p.name)
  if (explicit) {
    if (names.includes(explicit)) return explicit
    throw new Error(names.length
      ? `no profile named "${explicit}". Configured profiles: ${names.join(', ')}`
      : `no profile named "${explicit}", and none are configured. Run \`nhi-proxy setup\`.`)
  }
  if (profiles.length === 0) throw new NoProfilesError()
  if (profiles.length === 1) return profiles[0].name
  // never guess with several: the wrong one sends this organization's
  // credential to a different organization's platform
  throw new Error(
    'several profiles are configured, so --profile is required:\n' +
    profiles.map(p => `  ${p.name}  ${p.config.site}  :${p.config.port}`).join('\n')
  )
}

export const profileNameForSite = (site: string) => {
  const url = new URL(site)
  return url.port ? `${url.hostname}-${url.port}` : url.hostname
}

// A profile is one NHI, not one platform: several NHIs on the same platform is
// normal (different roles, departments, or machines). The host is only the
// starting point for a name, suffixed until it is free.
export const defaultProfileName = async (site: string) => {
  const base = profileNameForSite(site)
  const taken = new Set((await listProfiles()).map(p => p.name))
  if (!taken.has(base)) return base
  let n = 2
  while (taken.has(`${base}-${n}`)) n++
  return `${base}-${n}`
}

/** can this port actually be bound on the loopback interface right now? */
const bindable = (port: number) => new Promise<boolean>(resolve => {
  const probe = createServer()
  probe.once('error', () => resolve(false))
  probe.listen(port, '127.0.0.1', () => probe.close(() => resolve(true)))
})

/**
 * The next port to suggest: sequential from 7331, skipping both ports another
 * profile has claimed and ports something else on the machine is already
 * listening on. The suggestion is stored in the profile, so it stays put
 * afterwards — a tool config pointing at it keeps working.
 */
export const nextFreePort = async (start = 7331) => {
  const taken = new Set((await listProfiles()).map(p => p.config.port))
  let port = start
  while (taken.has(port) || !await bindable(port)) port++
  return port
}
