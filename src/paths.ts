import { homedir } from 'node:os'
import { join } from 'node:path'
import { mkdir, readFile, writeFile } from 'node:fs/promises'

export const configRoot = () =>
  join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'nhi-local')

export const profileDir = (profile: string) => join(configRoot(), profile)

export const ensureProfileDir = async (profile: string) => {
  const dir = profileDir(profile)
  await mkdir(dir, { recursive: true, mode: 0o700 })
  return dir
}

// secrets are written 0600 from the start: `mode` on writeFile only applies at
// creation, so an existing file is truncated and rewritten with its mode intact
export const writeSecret = async (dir: string, name: string, content: string) => {
  await writeFile(join(dir, name), content, { mode: 0o600 })
}

export const readSecret = (dir: string, name: string) =>
  readFile(join(dir, name), 'utf8')
