import { test } from 'node:test'
import assert from 'node:assert'
import { execFileSync } from 'node:child_process'
import { mkdtemp, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const repo = join(import.meta.dirname, '..')
const run = (cmd: string, args: string[], cwd: string, env: Record<string, string> = {}) =>
  execFileSync(cmd, args, { cwd, encoding: 'utf8', env: { ...process.env, ...env } })

/**
 * The published artifact must be JavaScript: node refuses to strip types for
 * anything under node_modules, so a `.ts` bin works from a clone and fails for
 * every installing user with ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING.
 * This packs and installs for real, because nothing short of that catches it.
 */
test('the packed package installs and its bin runs', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'nhi-pack-'))
  run('npm', ['pack', '--pack-destination', dir], repo)
  const tarball = (await readdir(dir)).find(f => f.endsWith('.tgz'))
  assert.ok(tarball, 'npm pack produced no tarball')

  run('npm', ['init', '-y'], dir)
  run('npm', ['install', join(dir, tarball)], dir)

  const bin = join(dir, 'node_modules', '.bin', 'nhi-proxy')
  assert.match(run(bin, ['--help'], dir), /nhi-proxy setup/)

  // and it must actually work, not merely print usage
  const home = await mkdtemp(join(tmpdir(), 'nhi-pack-home-'))
  run(bin, ['setup', '--site', 'https://koumoul.com', '--profile', 'packaged'], dir, { XDG_CONFIG_HOME: home })
  assert.match(run(bin, ['profiles'], dir, { XDG_CONFIG_HOME: home }), /packaged\s+https:\/\/koumoul\.com/)
})
