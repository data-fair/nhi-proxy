import neostandard from 'neostandard'

export default [
  { ignores: ['node_modules/*'] },
  ...neostandard({ ts: true })
]
