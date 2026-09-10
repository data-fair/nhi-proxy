import { join } from 'node:path'
import { readFile, writeFile } from 'node:fs/promises'
import { ensureProfileDir, profileDir } from './paths.ts'

export type NhiLocalConfig = {
  site: string
  sdPath: string
  clientId?: string
  issuer: string
  subject: string
  port: number
}

export const readConfig = async (profile: string): Promise<NhiLocalConfig> =>
  JSON.parse(await readFile(join(profileDir(profile), 'config.json'), 'utf8'))

export const writeConfig = async (profile: string, config: NhiLocalConfig) => {
  const dir = await ensureProfileDir(profile)
  await writeFile(join(dir, 'config.json'), JSON.stringify(config, null, 2) + '\n')
}
