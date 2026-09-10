import { listProfiles } from '../profiles.ts'

export const runProfiles = async () => {
  const profiles = await listProfiles()
  if (!profiles.length) {
    console.log('No profiles configured. Run `nhi-proxy setup`.')
    return
  }
  // one profile is one NHI, and several may share a platform, so the subject
  // and the client_id are what actually tell two rows apart
  const rows = profiles.map(p => [
    p.name,
    p.config.site,
    p.config.subject,
    String(p.config.port),
    p.config.clientId ?? 'not enrolled'
  ])
  const head = ['PROFILE', 'PLATFORM', 'SUBJECT', 'PORT', 'NHI']
  const widths = head.map((h, i) => Math.max(h.length, ...rows.map(r => r[i].length)))
  const line = (cells: string[]) =>
    cells.map((c, i) => i === cells.length - 1 ? c : c.padEnd(widths[i])).join('  ')
  console.log(line(head))
  for (const row of rows) console.log(line(row))
}
