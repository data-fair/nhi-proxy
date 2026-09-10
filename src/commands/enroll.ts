import { profileDir } from '../paths.ts'
import { readConfig, writeConfig } from '../config.ts'
import { loadSigningKey } from '../keys.ts'
import { SessionHolder } from '../session.ts'
import { resolveProfile } from '../profiles.ts'

export const runEnroll = async (clientId: string, profileOpt?: string) => {
  const profile = await resolveProfile(profileOpt)
  const config = { ...await readConfig(profile), clientId }
  await writeConfig(profile, config)
  const { key, kid } = await loadSigningKey(profileDir(profile))
  const holder = new SessionHolder({ config, key, kid })
  // a real exchange now, so misconfiguration surfaces here and not mid-session
  await holder.cookieHeader()
  console.log(`Enrolled ${clientId}: a test exchange with ${config.site} succeeded.`)
  console.log(`Start the proxy with:  nhi-proxy serve --profile ${profile}`)
}
