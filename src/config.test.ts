import { test } from 'node:test'
import assert from 'node:assert'
import { mkdtemp, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { writeSecret, readSecret, ensureProfileDir, profileDir } from './paths.ts'
import { writeConfig, readConfig } from './config.ts'

test('profileDir places a named profile under XDG config', () => {
  process.env.XDG_CONFIG_HOME = '/tmp/xdg-test'
  assert.equal(profileDir('koumoul.com'), '/tmp/xdg-test/nhi-proxy/koumoul.com')
  delete process.env.XDG_CONFIG_HOME
})

test('ensureProfileDir creates the directory mode 0700', async () => {
  process.env.XDG_CONFIG_HOME = await mkdtemp(join(tmpdir(), 'nhi-'))
  const dir = await ensureProfileDir('koumoul.com')
  assert.equal((await stat(dir)).mode & 0o777, 0o700)
  delete process.env.XDG_CONFIG_HOME
})

// the root holds every profile name; a recursive mkdir would leave it at
// 0777 & ~umask, so it is created and tightened explicitly
test('the config root is 0700, not just the profile directory', async () => {
  process.env.XDG_CONFIG_HOME = await mkdtemp(join(tmpdir(), 'nhi-'))
  await ensureProfileDir('koumoul.com')
  const root = join(process.env.XDG_CONFIG_HOME, 'nhi-proxy')
  assert.equal((await stat(root)).mode & 0o777, 0o700)
  delete process.env.XDG_CONFIG_HOME
})

test('writeSecret writes mode 0600 and round-trips', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'nhi-'))
  await writeSecret(dir, 'key.jwk', '{"kty":"EC"}')
  assert.equal((await stat(join(dir, 'key.jwk'))).mode & 0o777, 0o600)
  assert.equal(await readSecret(dir, 'key.jwk'), '{"kty":"EC"}')
})

test('config round-trips', async () => {
  process.env.XDG_CONFIG_HOME = await mkdtemp(join(tmpdir(), 'nhi-'))
  const cfg = {
    site: 'https://koumoul.com',
    sdPath: '/simple-directory',
    issuer: 'https://nhi-proxy.data-fair.cloud/9f3c1a',
    subject: 'alban@thinkpad',
    port: 7331
  }
  await writeConfig('koumoul.com', cfg)
  assert.deepEqual(await readConfig('koumoul.com'), cfg)
  delete process.env.XDG_CONFIG_HOME
})
