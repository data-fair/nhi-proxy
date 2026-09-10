import { profileDir } from '../paths.ts'
import { readConfig, writeConfig } from '../config.ts'
import { loadSigningKey } from '../keys.ts'
import { SessionHolder } from '../session.ts'
import { resolveProfile } from '../profiles.ts'

export const runEnroll = async (clientId: string, profileOpt?: string) => {
  const profile = await resolveProfile(profileOpt)
  const config = { ...await readConfig(profile), clientId }
  const { key, kid } = await loadSigningKey(profileDir(profile))
  const holder = new SessionHolder({ config, key, kid })
  // exchange BEFORE persisting: writing the client_id first would leave a
  // failed enrolment looking enrolled, so `serve` would start happily and every
  // request would fail instead — exactly the mid-session surprise this check
  // exists to prevent
  await holder.cookieHeader()
  await writeConfig(profile, config)
  console.log(`Enrolled ${clientId}: a test exchange with ${config.site} succeeded.`)
  console.log(`Start the proxy with:  nhi-proxy serve --profile ${profile}`)
}
