import { profileDir } from '../paths.ts'
import { readConfig } from '../config.ts'
import { publicJwks } from '../keys.ts'
import { resolveProfile } from '../profiles.ts'

export const runStatus = async (opts: { profile?: string, jwks?: boolean }) => {
  const profile = await resolveProfile(opts.profile)
  const config = await readConfig(profile)
  if (opts.jwks) {
    console.log(JSON.stringify(await publicJwks(profileDir(profile))))
    return
  }
  console.log(`profile   ${profile}`)
  console.log(`site      ${config.site}`)
  console.log(`sd path   ${config.sdPath}`)
  console.log(`issuer    ${config.issuer}`)
  console.log(`subject   ${config.subject}`)
  console.log(`client_id ${config.clientId ?? `(not enrolled — run \`nhi-proxy enroll <client_id> --profile ${profile}\`)`}`)
  console.log(`port      ${config.port}`)
}
