import { test } from 'node:test'
import assert from 'node:assert'
import { mkdtemp, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { writeSecret, readSecret, ensureProfileDir, profileDir } from './paths.ts'
import { writeConfig, readConfig } from './config.ts'

test('profileDir places a named profile under XDG config', () => {
  process.env.XDG_CONFIG_HOME = '/tmp/xdg-test'
  assert.equal(profileDir('koumoul.com'), '/tmp/xdg-test/nhi-local/koumoul.com')
  delete process.env.XDG_CONFIG_HOME
})

test('ensureProfileDir creates the directory mode 0700', async () => {
  process.env.XDG_CONFIG_HOME = await mkdtemp(join(tmpdir(), 'nhi-'))
  const dir = await ensureProfileDir('koumoul.com')
  assert.equal((await stat(dir)).mode & 0o777, 0o700)
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
    issuer: 'https://nhi-local.data-fair.cloud/9f3c1a',
    subject: 'alban@thinkpad',
    port: 7331
  }
  await writeConfig('koumoul.com', cfg)
  assert.deepEqual(await readConfig('koumoul.com'), cfg)
  delete process.env.XDG_CONFIG_HOME
})
