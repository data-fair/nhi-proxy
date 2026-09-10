import { test } from 'node:test'
import assert from 'node:assert'
import { mkdtemp, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runSetup, DEFAULT_SITE } from './setup.ts'
import { readConfig, writeConfig } from '../config.ts'
import { listProfiles, defaultProfileName } from '../profiles.ts'

const freshHome = async () => {
  process.env.XDG_CONFIG_HOME = await mkdtemp(join(tmpdir(), 'nhi-'))
}

test('the default platform is koumoul.com', () => {
  assert.equal(DEFAULT_SITE, 'https://koumoul.com')
})

test('setup names the profile after the site host and writes secrets 0600', async () => {
  await freshHome()
  const out = await runSetup({ site: 'https://koumoul.com/', subject: 'alban@thinkpad' })

  assert.equal(out.profile, 'koumoul.com')
  const cfg = await readConfig('koumoul.com')
  assert.equal(cfg.site, 'https://koumoul.com', 'a trailing slash is stripped: the audience must match exactly')
  assert.equal(cfg.sdPath, '/simple-directory')
  assert.equal(cfg.subject, 'alban@thinkpad')
  assert.equal(cfg.port, 7331)
  assert.match(cfg.issuer, /^https:\/\/nhi-local\.data-fair\.cloud\/[0-9a-f]+$/)
  assert.equal(cfg.clientId, undefined, 'enrollment has not happened yet')

  assert.equal((out.jwks.keys[0] as any).d, undefined, 'only the public key is ever printed')

  const dir = join(process.env.XDG_CONFIG_HOME!, 'nhi-local', 'koumoul.com')
  for (const f of ['key.jwk', 'ca.key', 'leaf.key']) {
    assert.equal((await stat(join(dir, f))).mode & 0o777, 0o600, `${f} must be 0600`)
  }
  delete process.env.XDG_CONFIG_HOME
})

test('a second profile gets its own name and the next free port', async () => {
  await freshHome()
  await runSetup({ site: 'https://koumoul.com' })
  const second = await runSetup({ site: 'https://staging.koumoul.com' })
  assert.equal(second.profile, 'staging.koumoul.com')
  assert.equal((await readConfig('staging.koumoul.com')).port, 7332)
  assert.deepEqual((await listProfiles()).map(p => p.name), ['koumoul.com', 'staging.koumoul.com'])
  delete process.env.XDG_CONFIG_HOME
})

test('setup refuses to clobber an existing profile without --rotate', async () => {
  await freshHome()
  await runSetup({ site: 'https://koumoul.com' })
  await assert.rejects(runSetup({ site: 'https://koumoul.com' }), /--rotate/)
  delete process.env.XDG_CONFIG_HOME
})

// a profile is one NHI, not one platform: several NHIs on the same platform is
// a normal setup (different roles, departments, or machines)
test('several NHIs can live on the same platform under different profiles', async () => {
  await freshHome()
  const first = await runSetup({ site: 'https://koumoul.com' })
  const second = await runSetup({ site: 'https://koumoul.com', profile: 'koumoul-readonly' })

  assert.equal(first.profile, 'koumoul.com')
  assert.equal(second.profile, 'koumoul-readonly')
  assert.equal(second.site, first.site, 'same platform')
  assert.notEqual(second.issuer, first.issuer, 'each NHI gets its own issuer')
  assert.notDeepEqual(second.jwks, first.jwks, 'and its own key')
  assert.equal(second.port, first.port + 1, 'and its own port')
  assert.deepEqual((await listProfiles()).map(p => p.name), ['koumoul-readonly', 'koumoul.com'])
  delete process.env.XDG_CONFIG_HOME
})

// the derived name is not auto-suffixed: a script re-running setup must fail
// loudly rather than quietly enrol a second NHI
test('a bare repeat is refused and explains how to name the second NHI', async () => {
  await freshHome()
  await runSetup({ site: 'https://koumoul.com' })
  await assert.rejects(runSetup({ site: 'https://koumoul.com' }), (err: Error) => {
    assert.match(err.message, /Each NHI gets its own profile/)
    assert.match(err.message, /--profile <name>/)
    return true
  })
  assert.equal((await listProfiles()).length, 1, 'no second profile may appear')
  delete process.env.XDG_CONFIG_HOME
})

test('the wizard default name steps aside when the host name is taken', async () => {
  await freshHome()
  assert.equal(await defaultProfileName('https://koumoul.com'), 'koumoul.com')
  await runSetup({ site: 'https://koumoul.com' })
  assert.equal(await defaultProfileName('https://koumoul.com'), 'koumoul.com-2')
  await runSetup({ site: 'https://koumoul.com', profile: 'koumoul.com-2' })
  assert.equal(await defaultProfileName('https://koumoul.com'), 'koumoul.com-3')
  delete process.env.XDG_CONFIG_HOME
})

test('--rotate never creates a profile', async () => {
  await freshHome()
  await assert.rejects(runSetup({ site: 'https://koumoul.com', rotate: true }))
  assert.deepEqual(await listProfiles(), [], 'rotate must not enrol anything')
  delete process.env.XDG_CONFIG_HOME
})

test('--rotate targets the only profile whatever it is named', async () => {
  await freshHome()
  await runSetup({ site: 'https://staging.koumoul.com', profile: 'my-agent' })
  const out = await runSetup({ rotate: true })
  assert.equal(out.profile, 'my-agent')
  // a bare --rotate must not silently repoint the profile at the default platform
  assert.equal(out.site, 'https://staging.koumoul.com')
  delete process.env.XDG_CONFIG_HOME
})

test('--rotate requires --profile once several NHIs exist', async () => {
  await freshHome()
  await runSetup({ site: 'https://koumoul.com' })
  await runSetup({ site: 'https://koumoul.com', profile: 'koumoul-readonly' })
  await assert.rejects(runSetup({ rotate: true }), /--profile/)
  const out = await runSetup({ rotate: true, profile: 'koumoul-readonly' })
  assert.equal(out.profile, 'koumoul-readonly')
  delete process.env.XDG_CONFIG_HOME
})

test('--rotate keeps the client_id, so the admin re-pastes onto the same NHI', async () => {
  await freshHome()
  const created = await runSetup({ site: 'https://koumoul.com' })
  await writeConfig('koumoul.com', { ...await readConfig('koumoul.com'), clientId: 'nhi-V1StGXR8Z5' })
  const rotated = await runSetup({ rotate: true })
  const after = await readConfig('koumoul.com')
  assert.equal(after.clientId, 'nhi-V1StGXR8Z5')
  assert.equal(rotated.issuer, created.issuer)
  assert.notDeepEqual(rotated.jwks, created.jwks)
  delete process.env.XDG_CONFIG_HOME
})

test('--rotate replaces the key but keeps the binding identity', async () => {
  await freshHome()
  const first = await runSetup({ site: 'https://koumoul.com' })
  const before = await readConfig('koumoul.com')
  const again = await runSetup({ site: 'https://koumoul.com', rotate: true })
  const after = await readConfig('koumoul.com')
  assert.equal(after.issuer, before.issuer, 'issuer is part of the admin-side binding')
  assert.equal(after.subject, before.subject)
  assert.equal(after.port, before.port)
  assert.notDeepEqual(again.jwks, first.jwks, 'the key material must actually change')
  delete process.env.XDG_CONFIG_HOME
})

test('setup defaults the subject to user@hostname', async () => {
  await freshHome()
  const out = await runSetup({ site: 'https://koumoul.com' })
  assert.match(out.subject, /^.+@.+$/)
  delete process.env.XDG_CONFIG_HOME
})

test('setup rejects a site with a path, which would break the audience', async () => {
  await freshHome()
  await assert.rejects(runSetup({ site: 'https://koumoul.com/simple-directory' }), /origin/i)
  delete process.env.XDG_CONFIG_HOME
})
