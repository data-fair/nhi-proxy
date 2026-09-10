import { homedir } from 'node:os'
import { join } from 'node:path'
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises'

export const configRoot = () =>
  join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'nhi-proxy')

export const profileDir = (profile: string) => join(configRoot(), profile)

export const ensureProfileDir = async (profile: string) => {
  // the root has to be created (and tightened) on its own: a recursive mkdir
  // applies `mode` to the leaf only, so the parent would land at 0777 & ~umask
  // — 0755 or 0775 on a typical box, leaving profile names world-listable
  const root = configRoot()
  await mkdir(root, { recursive: true, mode: 0o700 })
  await chmod(root, 0o700)
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
