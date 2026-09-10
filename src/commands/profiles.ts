import { listProfiles } from '../profiles.ts'

export const runProfiles = async () => {
  const profiles = await listProfiles()
  if (!profiles.length) {
    console.log('No profiles configured. Run `nhi-local setup`.')
    return
  }
  for (const p of profiles) {
    const enrolled = p.config.clientId ?? 'not enrolled'
    console.log(`${p.name}\t${p.config.site}\t:${p.config.port}\t${enrolled}`)
  }
}
