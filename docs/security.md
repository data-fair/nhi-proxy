# Security

What nhi-proxy defends against, and how to keep its signing key away from the
agent it serves.

## What it guarantees

- The credential never enters the agent's context, transcripts, or tool output.
- Sessions last at most 30 minutes and are non-refreshable by construction.
- The identity is scoped to exactly one organization, can never be an admin, and
  can never be an impersonation target.
- The proxy intercepts exactly one host. Every other CONNECT is tunnelled
  byte-for-byte, uninspected.
- Out of scope: a malicious process running as your own user. See
  [the caveat](#the-caveat) below, which says plainly what key protection does
  and does not buy.

## Keeping the key away from your agent

There is no cross-harness convention for this — Claude Code's own documentation
states that "there is no built-in credential deny list". Three tiers, in
increasing strength.

### Tier 1 — per-harness deny rules (advisory)

Claude Code, in `~/.claude/settings.json`:

```json
{ "permissions": { "deny": ["Read(~/.config/nhi-proxy/**)"] } }
```

In *user* settings a bare `Read(/foo/**)` resolves against `~/.claude`, so the
`~/` or `//` form is mandatory. A `Read` deny also blocks Edit and Write there.

opencode, in `~/.config/opencode/opencode.json` — last matching rule wins, so
the catch-all goes first:

```json
{ "permission": { "read": { "*": "allow", "~/.config/nhi-proxy/*": "deny" } } }
```

These are guardrails, not boundaries. Claude Code's docs name the holes: the
rules cover built-in file tools and bash commands it recognizes (`cat`, `head`,
`tail`, `sed`), but not `grep -r` run from a parent directory, and not a script
that opens the file itself.

### Tier 2 — Claude Code's sandbox (OS-enforced)

Purpose-built for this, and it closes Tier 1's holes because it applies to every
sandboxed Bash command *and its child processes*:

```json
{ "sandbox": { "credentials": { "files": [
  { "path": "~/.config/nhi-proxy", "mode": "deny" }
] } } }
```

Requires Claude Code v2.1.187+ with the sandbox enabled. A `deny` entry merges
across settings scopes and no scope can remove one another scope added. Limits:
Claude Code only, sandboxed commands only, and `sandbox.filesystem.disabled`
lifts it.

### Tier 3 — a separate OS user (recommended where it matters)

Run the daemon under its own uid with the key `0600` owned by it. The only tier
that holds regardless of which harness is running, including one nobody
configured.

```ini
# /etc/systemd/system/nhi-proxy.service
[Unit]
Description=nhi-proxy NHI credential proxy
After=network.target

[Service]
User=nhi-proxy
Group=nhi-proxy
Environment=XDG_CONFIG_HOME=/var/lib/nhi-proxy/.config
ExecStart=/usr/bin/npx @data-fair/nhi-proxy serve --profile koumoul.com
Restart=on-failure

[Install]
WantedBy=multi-user.target
```

### The caveat

> The key is the only *durable* secret. Hiding it means a leak cannot outlive the
> daemon or move to another machine. It does not mean a local agent cannot use
> the identity — anything running as your user can point at the proxy port and
> get authenticated traffic without ever touching the key. That is the intended
> behavior; the agent is meant to use the proxy.

## See also

- [Usage guide](usage.md)
- [Design spec](superpowers/specs/2026-09-10-nhi-proxy-design.md), whose
  threat-model section is the authoritative version of the above
