import { join } from 'node:path'
import { profileDir } from '../paths.ts'
import { loadCa, spkiPin } from '../ca.ts'
import { resolveProfile } from '../profiles.ts'

export const runCa = async (opts: { profile?: string, spki?: boolean }) => {
  const dir = profileDir(await resolveProfile(opts.profile))
  if (opts.spki) console.log(spkiPin(await loadCa(dir)))
  else console.log(join(dir, 'ca.crt'))
}
