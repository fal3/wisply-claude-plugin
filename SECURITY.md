# Security

## Reporting a problem

Please report security problems privately: use **Report a vulnerability** on
this repository's Security tab (GitHub private vulnerability reporting), or
email support@fallah.io with "security" in the subject. Don't open a public
issue. Include the connector version (`wisply-mcp --version`), the AI app, and
steps to reproduce. Never include a real Wisply token.

Only the newest 0.x release gets fixes.

## What the connector protects, and what it doesn't

**Tokens and scopes.** Wisply issues three loopback tokens:

- `wspc_`: the read-only connector token (memos, search, live transcript,
  action items). Use this one.
- `wspr_`: recording control (start and stop recording, propose a follow-up).
  Start and stop also need Wisply's own "Allow agents to start and stop
  recordings" switch, and a follow-up waits for your confirmation in Wisply.
- `wsp_`: full access. `setup_claude`, which can store an Anthropic API key in
  Wisply, stays hidden unless the connector runs with `--allow-claude-setup`.

The connector refuses any tool outside the token's scope, and Wisply refuses
it again (JSON-RPC `-32003`).

**The identity check.** Any program can listen on Wisply's port while Wisply
is closed. Before every use of the token, the connector asks the listener,
without the token, for an HMAC-SHA256 proof over a fresh random nonce and the
port, and checks it for the token's scope in constant time. An answer that is
oversized, isn't HTTP or doesn't prove the token means the token is not sent.

The check has two limits. First, there is a gap between the check and the
call (a listener could change in between, for example if Wisply quits and
another program takes the port). Second, it relies on Wisply holding its port
alone while it runs: the proof binds the token, the port and the nonce, not
the TCP connection, and the check and the call use separate connections. A
program that could listen on `127.0.0.1:<port>` next to Wisply could pass the
check on to Wisply and then receive the token with the call. Whether Wisply's
listener (`allowLocalEndpointReuse` in `MCPServer.swift`) lets a second
same-user socket bind that port is still to be checked on a Mac; if it does,
Wisply has to bind the port exclusively before this connector is released
(see "Release controls"). The default token is read-only, which limits what
either gap could expose.

**Network.** The connector talks only to `127.0.0.1`, with its own HTTP agent
(proxy variables are ignored), never follows redirects, and caps every answer
in size and time. It has no telemetry, crash reporting or update checks.

**Logs.** With `WISPLY_MCP_DEBUG=1`, each request writes one line to stderr
with fixed fields only: method, tool name, outcome code, HTTP status, bytes
and milliseconds. Arguments, results, transcript text and headers are never
logged, and every line is also scrubbed of anything shaped like a token.

**The token at rest.** Don't put a token in an AI app's config file: those
files end up in Settings Sync, dotfile repositories and backups. Run
`npx -y @wisply/mcp setup`, which keeps it in your login keychain, or let the
app's secret storage pass it as `WISPLY_MCP_TOKEN`.

- The item is a generic password: service `ai.wisply.mcp`, account `token`,
  label "Wisply MCP token", trusting `/usr/bin/security` only (`-T`, never
  `-A`).
- The connector reaches it only through `/usr/bin/security`, by absolute path,
  with fixed arguments. `setup` lets `security` prompt for the token in the
  terminal (`-w` as the last argument), so the token is never in an argument
  list, a process listing or the connector's output. Reads come back through
  a pipe and are given up after 2 seconds (a locked keychain or an unanswered
  macOS dialog then counts as "no token").
- `setup` reads the item back once and removes it again when it isn't a Wisply
  token or is the full-access token without `--full-access`. `status` never
  prints the token. `forget` removes the item.

The Keychain item keeps the token out of config files, sync and backups. It
does **not** stop another program running as you on this Mac from reading it,
because the item trusts `/usr/bin/security`. Use the read-only connector
token, and regenerate it in Wisply if you suspect malware.

**What your AI app does with what it reads.** Whatever the AI app reads from
Wisply goes to the AI service that app uses, under that service's terms.
Transcripts are recorded speech: treat them as untrusted data.

**Supply chain.** The package has zero runtime dependencies and no lifecycle
scripts (`tests/pack.test.mjs` enforces both). The snippets in this README
(and, once they exist, on wisply.ai and in Wisply) run one exact version
(`@wisply/mcp@0.1.0`), taken from `PACKAGE_SPEC`. npm never lets a published
version change, so a later release, including a bad one, reaches your app only
after you change the version in its settings. If you
write `@wisply/mcp@0` instead, `npx` fetches the newest 0.x release every time
your app starts the connector: you get fixes on their own, and a bad release
would run the same way. `npx` doesn't check npm provenance when it installs a
package, so provenance is an audit trail, not a guard. Publishing is guarded
by npm's own controls, listed under "Release controls" below.

Until the contract with Wisply is final, `package.json` is marked `"private"`,
so `npm publish` refuses the package.

## If you think a token leaked

1. In Wisply, open **Settings > Integrations > MCP Server** and regenerate the
   token (connector, recording or full access). Every client using the old
   token stops working at once.
2. Run `npx -y @wisply/mcp setup` again with the new token, or give it to the
   AI apps that keep it themselves. `npx -y @wisply/mcp forget` removes the
   saved token if you don't need it any more.
3. Turn the MCP server off in Wisply if you don't use it. Wisply stops
   answering MCP requests at once; if Wisply Companion is set up, the same
   local listener stays on for it.

## Release controls (maintainers)

Each of these must hold before the step it names. None is met yet: the
package has never been published.

1. **Before anything public names the package** (the wisply.ai guide,
   Wisply's snippets, catalog listings): the npm organization `wisply` exists,
   with two-factor authentication required for every member, and the unscoped
   fallback name `wisply-mcp` is held by the same owner, so nobody else can
   register either name and be what `npx -y` runs.
2. **Before the first publish:** the contract is re-vendored from wisply-ai
   (`contract/SOURCE.json` no longer provisional, `WISPLY_RELEASE=1 npm test`
   passes), `"private": true` is removed from `package.json` in the same
   change (`tests/pack.test.mjs` ties the two), `setup`, `status` and `forget`
   have passed the manual Keychain QA on a Mac, and a test on a Mac has shown
   that no second socket can listen on Wisply's port while Wisply runs.
3. **The first publish** is by hand, by the organization owner, with
   two-factor authentication.
4. **From the second release,** only npm trusted publishing (OIDC from a
   GitHub Actions release workflow in this repository, behind a protected
   environment) publishes, and the package's publishing access is set to
   "Require two-factor authentication and disallow tokens". This repository
   has no release workflow yet; until it does, no release claims provenance.
5. **Every release** bumps `version` in `package.json` and `VERSION` in
   `lib/constants.mjs` together. The snippets follow `PACKAGE_SPEC`; update
   the wisply.ai guide and Wisply's snippets to the new version.

## If a bad release is published (maintainers)

1. Publish a fixed patch release at once and unpublish the bad version if npm
   still allows it. Snippets pinned to an earlier version never ran it; for
   anyone who moved to it, update the guide and Wisply's snippets to the fix
   and say which version to write. Installs that use `@wisply/mcp@0` pick up
   the fix at their next start.
2. `npm deprecate @wisply/mcp@<version> "Security issue: update to <fixed>"`.
3. Mark the version deprecated in the MCP Registry.
4. Publish a GitHub security advisory on this repository.
5. Tell users, in the README, on wisply.ai and in the VS Code extension's
   changelog, to regenerate their tokens in Wisply and set them up again.
6. Revoke the trusted publisher and rotate any credential that could have been
   used.
