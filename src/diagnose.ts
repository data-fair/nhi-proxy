export type ExchangeContext = {
  status: number
  dateHeader?: string
  site: string
  clientId?: string
  now?: number
}

// A two-minute assertion lifetime turns even modest clock drift into a
// permanent, undiagnosable 401. Anything past half the lifetime is worth naming.
const SKEW_TOLERANCE_MS = 60_000

const humanDuration = (ms: number) => {
  const s = Math.round(Math.abs(ms) / 1000)
  return s >= 60 ? `${Math.floor(s / 60)}m${String(s % 60).padStart(2, '0')}s` : `${s}s`
}

export const diagnose = (ctx: ExchangeContext): string => {
  if (ctx.status === 404) {
    return `NHI support is not enabled on ${ctx.site} (config.manageNhis is false) — an operator must enable it.`
  }
  if (ctx.status === 429) {
    return 'Hit simple-directory\'s auth rate limit. It consumes a point on every exchange, successful or not, and is keyed by both your IP and your client_id. Wait and retry; if this recurs, an operator may need to raise authRateLimit.'
  }
  if (!ctx.clientId) {
    return 'No client_id configured — run `nhi-local enroll <client_id>` with the id your org admin returned.'
  }
  if (ctx.dateHeader) {
    const serverMs = Date.parse(ctx.dateHeader)
    const skew = (ctx.now ?? Date.now()) - serverMs
    if (Number.isFinite(serverMs) && Math.abs(skew) > SKEW_TOLERANCE_MS) {
      const direction = skew > 0 ? 'ahead of' : 'behind'
      return `Local clock is ${humanDuration(skew)} ${direction} ${ctx.site}. Assertions live 120s, so this alone rejects every exchange. Fix the system clock (NTP) and retry.`
    }
  }
  // simple-directory returns an identical 401 for every remaining cause, so
  // list what the user can actually check
  return [
    `Exchange rejected by ${ctx.site} (simple-directory returns the same 401 for every cause, so check each):`,
    `  - is client_id ${ctx.clientId} the exact id your admin returned?`,
    `  - is the site "${ctx.site}" byte-for-byte the origin the NHI was created for? it is the assertion audience`,
    '  - does the binding\'s inline JWKS still match this profile\'s key? re-paste `nhi-local status --jwks` if the key was rotated',
    '  - was the NHI deleted or moved to another organization?'
  ].join('\n')
}
