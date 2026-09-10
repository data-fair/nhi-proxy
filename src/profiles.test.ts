import { test } from 'node:test'
import assert from 'node:assert'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:net'
import {
  listProfiles, resolveProfile, profileNameForSite, nextFreePort, NoProfilesError
} from './profiles.ts'

const cfg = (site: string, port: number) => JSON.stringify({
  site,
  sdPath: '/simple-directory',
  issuer: 'https://nhi-proxy.data-fair.cloud/x',
  subject: 'a@b',
  port
})

const withProfiles = async (profiles: Record<string, string>) => {
  const root = await mkdtemp(join(tmpdir(), 'nhi-'))
  process.env.XDG_CONFIG_HOME = root
  for (const [name, content] of Object.entries(profiles)) {
    const dir = join(root, 'nhi-proxy', name)
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'config.json'), content)
  }
  return root
}

test('profileNameForSite derives a filesystem-safe name from the host', () => {
  assert.equal(profileNameForSite('https://koumoul.com'), 'koumoul.com')
  assert.equal(profileNameForSite('https://staging.koumoul.com'), 'staging.koumoul.com')
  assert.equal(profileNameForSite('http://localhost:5600'), 'localhost-5600')
})

test('a directory without config.json is not a profile', async () => {
  const root = await withProfiles({ 'koumoul.com': cfg('https://koumoul.com', 7331) })
  await mkdir(join(root, 'nhi-proxy', 'leftover'), { recursive: true })
  assert.deepEqual((await listProfiles()).map(p => p.name), ['koumoul.com'])
  delete process.env.XDG_CONFIG_HOME
})

test('with no profiles, resolveProfile signals that setup is needed', async () => {
  await withProfiles({})
  await assert.rejects(resolveProfile(), (err: Error) => err instanceof NoProfilesError)
  delete process.env.XDG_CONFIG_HOME
})

test('with exactly one profile it is used implicitly', async () => {
  await withProfiles({ 'koumoul.com': cfg('https://koumoul.com', 7331) })
  assert.equal(await resolveProfile(), 'koumoul.com')
  delete process.env.XDG_CONFIG_HOME
})

test('with several profiles and no --profile it refuses and lists them', async () => {
  await withProfiles({
    'koumoul.com': cfg('https://koumoul.com', 7331),
    'staging.koumoul.com': cfg('https://staging.koumoul.com', 7332)
  })
  await assert.rejects(resolveProfile(), (err: Error) => {
    assert.ok(!(err instanceof NoProfilesError))
    assert.match(err.message, /--profile/)
    assert.match(err.message, /koumoul\.com/)
    assert.match(err.message, /staging\.koumoul\.com/)
    return true
  })
  delete process.env.XDG_CONFIG_HOME
})

test('an explicit profile is used, and an unknown one lists what exists', async () => {
  await withProfiles({
    'koumoul.com': cfg('https://koumoul.com', 7331),
    'staging.koumoul.com': cfg('https://staging.koumoul.com', 7332)
  })
  assert.equal(await resolveProfile('staging.koumoul.com'), 'staging.koumoul.com')
  await assert.rejects(resolveProfile('typo'), /koumoul\.com/)
  delete process.env.XDG_CONFIG_HOME
})

test('nextFreePort starts at 7331 and skips ports already claimed', async () => {
  await withProfiles({})
  assert.equal(await nextFreePort(), 7331)
  await withProfiles({
    a: cfg('https://a.example.com', 7331),
    b: cfg('https://b.example.com', 7332)
  })
  assert.equal(await nextFreePort(), 7333)
  delete process.env.XDG_CONFIG_HOME
})

// suggesting a port that something else already holds only defers the failure
// to `serve`, where it used to surface as a raw EADDRINUSE stack
test('nextFreePort skips a port held by an unrelated process', async () => {
  await withProfiles({})
  const squatter = createServer()
  await new Promise<void>(resolve => squatter.listen(7331, '127.0.0.1', resolve))
  assert.equal(await nextFreePort(), 7332)
  await new Promise<void>(resolve => squatter.close(() => resolve()))
  assert.equal(await nextFreePort(), 7331, 'and offers it again once released')
  delete process.env.XDG_CONFIG_HOME
})
