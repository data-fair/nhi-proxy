# Contribution guidelines

## Setup

Switch to the appropriate Node.js version:

    nvm use

Install dependencies:

    npm install

## Development

Available scripts in `package.json`:

- `npm test`: run the unit tests
- `npm run e2e`: bring up an isolated simple-directory in Docker, seed it, and
  run the end-to-end test — one command, no manual setup (see
  [`test-e2e/README.md`](test-e2e/README.md))
- `npm run e2e-stack` / `npm run e2e-stack-down`: manage that stack on its own
- `npm run test-e2e`: run the end-to-end test against a stack you configured
  yourself via `E2E_*` environment variables
- `npm run lint` / `npm run lint-fix`: eslint
- `npm run check-types`: tsc
- `npm run quality`: all of the above

There is no build step. Node 24 runs the TypeScript sources directly via type
stripping, which is why `enum`, `namespace` and decorators are not available and
type-only imports must use `import type`.

## Trying it by hand

Point `XDG_CONFIG_HOME` at a scratch directory so you never touch your real
profiles:

```bash
export XDG_CONFIG_HOME=$(mktemp -d)
node bin/nhi-local.ts setup --site https://koumoul.com < /dev/null
node bin/nhi-local.ts profiles
node bin/nhi-local.ts ca --spki
```

`setup` prompts only when stdin is a TTY; redirecting from `/dev/null` runs it
from flags alone, which is also how the tests drive it.
