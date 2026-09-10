#!/usr/bin/env node
import { parseArgs } from 'node:util'
import { runSetupWizard } from '../src/commands/setup.ts'
import { runEnroll } from '../src/commands/enroll.ts'
import { runServe } from '../src/commands/serve.ts'
import { runStatus } from '../src/commands/status.ts'
import { runCa } from '../src/commands/ca.ts'
import { runProfiles } from '../src/commands/profiles.ts'
import { listProfiles, NoProfilesError } from '../src/profiles.ts'

const USAGE = `nhi-local — local NHI credential provider for agentic coding tools

  nhi-local                       set up on first run, then serve
  nhi-local setup [--site <origin>] [--profile <p>] [--subject <s>]
                  [--sd-path <p>] [--port <n>] [--rotate]
  nhi-local enroll <client_id> [--profile <p>]
  nhi-local serve [--port <n>] [--profile <p>]
  nhi-local status [--jwks] [--profile <p>]
  nhi-local ca [--spki] [--profile <p>]
  nhi-local profiles

With one profile configured, --profile can be omitted everywhere.
`

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    site: { type: 'string' },
    subject: { type: 'string' },
    profile: { type: 'string' },
    'sd-path': { type: 'string' },
    port: { type: 'string' },
    rotate: { type: 'boolean' },
    spki: { type: 'boolean' },
    jwks: { type: 'boolean' },
    help: { type: 'boolean', short: 'h' }
  }
})

const [command, arg] = positionals
const port = values.port ? Number(values.port) : undefined

// bare `nhi-local` does the next useful thing, so a first-time user who types
// the name and nothing else is carried from setup to a running proxy
const runBare = async () => {
  const profiles = await listProfiles()
  if (profiles.length === 0) {
    const out = await runSetupWizard({})
    const fresh = (await listProfiles()).find(p => p.name === out.profile)
    if (fresh?.config.clientId) await runServe({ profile: out.profile })
    return
  }
  // with several, runServe's resolveProfile refuses and lists them
  await runServe({ profile: values.profile })
}

try {
  if (values.help) console.log(USAGE)
  else if (!command) await runBare()
  else if (command === 'setup') {
    await runSetupWizard({
      site: values.site,
      profile: values.profile,
      subject: values.subject,
      sdPath: values['sd-path'],
      port,
      rotate: values.rotate
    })
  } else if (command === 'enroll') {
    if (!arg) throw new Error('enroll requires a client_id, e.g. `nhi-local enroll nhi-V1StGXR8Z5`')
    await runEnroll(arg, values.profile)
  } else if (command === 'serve') await runServe({ profile: values.profile, port })
  else if (command === 'status') await runStatus({ profile: values.profile, jwks: values.jwks })
  else if (command === 'ca') await runCa({ profile: values.profile, spki: values.spki })
  else if (command === 'profiles') await runProfiles()
  else throw new Error(`unknown command "${command}"\n\n${USAGE}`)
} catch (err: any) {
  if (err instanceof NoProfilesError) console.error('No profile configured. Run `nhi-local setup`.')
  else console.error(err.message)
  process.exit(1)
}
