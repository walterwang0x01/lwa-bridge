# Security policy

## Reporting a vulnerability

If you discover a security issue in `lark-kiro-bridge`, please **do not** open a
public issue or pull request. Instead:

1. Open a [private security advisory](https://github.com/walterwang0x01/lark-kiro-bridge/security/advisories/new)
   on GitHub, or
2. Email the maintainer with the subject line `[lark-kiro-bridge security]` and a
   reproduction case.

Please include:

- The affected version (or git commit SHA).
- A description of the issue and its potential impact.
- Steps to reproduce, ideally a minimal proof of concept.
- Any suggested mitigation, if you have one.

We aim to acknowledge reports within 5 working days. After validation, we will
coordinate a fix and release window with you before public disclosure.

## Scope

Issues that fall in scope include:

- Credential leakage (`appSecret`, access tokens) via logs, error messages,
  stack traces, or config files.
- Path traversal, arbitrary file write/read outside `workspace.allowedRoots`.
- Privilege escalation between chats or users (e.g. a non-admin gaining `/cd`
  ability).
- Authentication bypass on Lark long-connection events.
- Remote code execution via crafted message payloads.
- Replay or injection attacks on card callbacks.

Issues that fall **out** of scope:

- The fact that the bot can run arbitrary commands at the user's behest — this
  is the design goal. To restrict this, configure `kiro.trustedTools` to the
  minimum set you need.
- The fact that `/cd` is gated only by `workspace.allowedRoots` and admin status
  — this is by design. Tighten `allowedRoots` and `access.admins` to enforce
  policy.
- Bugs in upstream `kiro-cli`, the Lark Open Platform SDK, or pino — please
  report those to the respective projects.

## Web Dashboard (local HTTP server)

Since v0.10, the bridge starts a local, read-only HTTP server (default
`http://127.0.0.1:5180`) that serves a Vue-based status dashboard: session
list, cron tasks, running processes, `~/.kiro/skills` names/descriptions, and
recent log lines.

Threat model / what's already mitigated:

- **Bind address**: the server binds to `127.0.0.1` only, never `0.0.0.0`. It
  is not reachable from your LAN or the internet by default.
- **No write operations**: every route is `GET`-only; there is no way to
  trigger a Kiro task, mutate config, or run `/conduit` from the dashboard
  itself (that capability is a stated non-goal for now — see README roadmap).
- **No secrets in the API response**: `/api/overview` never includes
  `appSecret`, tokens, or the full `config.json`.
- **Static file serving is path-traversal-guarded**: requests are resolved
  against the dashboard build directory and rejected if they resolve outside
  it.

What's in scope for reports:

- Any way to reach the dashboard from outside `127.0.0.1` without the user
  explicitly proxying it (e.g. via `tailscale serve`, an SSH tunnel, or
  manually rebinding the port).
- Any endpoint that returns `appSecret`, cron prompts belonging to another
  user's chat that shouldn't be visible, or file contents outside
  `~/.kiro/skills`.
- Path traversal in the static file server (e.g. `/../../etc/passwd`).

If you expose the dashboard beyond localhost (Tailscale, reverse proxy, port
forwarding), you are responsible for adding your own authentication in front
of it — the dashboard itself has none, by design, because it assumes
single-machine trust.

## Hardening guidance

Even without an active vulnerability, you can reduce blast radius:

- Set `workspace.allowedRoots` to the smallest possible set of directories.
- Restrict `kiro.trustedTools` (e.g. drop `shell` if you don't need command
  execution).
- Populate `access.allowedUsers`, `access.allowedChats`, `access.admins` with
  explicit allowlists before sharing the bot with a team.
- Run the bridge under a dedicated UNIX user, not your main login account.
- Keep `~/.lark-kiro-bridge/config.json` at mode `0600` (the bridge enforces
  this on init, but verify if you edit by hand).
- Rotate `appSecret` if it has ever been logged in plaintext, screenshotted, or
  shared in a chat.
- Set `dashboard.enabled: false` if you don't use it — one less local surface.
- If you expose the dashboard beyond `127.0.0.1`, put an authenticating proxy
  in front of it (Tailscale ACLs, an SSH tunnel, or a reverse proxy with
  basic auth); do not rebind it to `0.0.0.0` directly.

## Supported versions

Only the latest minor release is supported with security fixes. Pre-1.0 versions
get fixes on a best-effort basis on `main`.
