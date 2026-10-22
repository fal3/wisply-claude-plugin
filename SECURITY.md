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
check on to Wisply and then receive the token with the call. Wisply's
listener sets `allowLocalEndpointReuse = true` (`MCPServer.swift`), so
whether a second same-user socket can bind that port is still to be checked
on a Mac; if it can, Wisply has to bind the port exclusively before this
connector is released. The release check enforces this: `WISPLY_RELEASE=1 npm
test` fails until `docs/release-checks.json` records, for the Wisply commit
the contract is vendored from, how exclusivity was shown (see "Release
controls"). The default token is read-only, which limits what either gap
could expose.

**Network.** The connector talks only to `127.0.0.1`, with its own HTTP agent
(proxy variables are ignored), never follows redirects, and caps every answer
in size and time. It has no telemetry, crash reporting or update checks.

**Logs.** With `WISPLY_MCP_DEBUG=1`, each request writes one line to stderr
with fixed fields only: method, tool name, outcome code, HTTP status, bytes
and milliseconds. Arguments, results, transcript text and headers are never
logged, and every line is also scrubbed of anything shaped like a token.

**The token at rest.** Don't put a token in an AI app's config file: those
files end up in Settings Sync, dotfile repositories and backups. Let the app's
secret storage pass it as `WISPLY_MCP_TOKEN`, or (from the first release) run
`npx -y --prefix / @wisply/mcp@0.1.0 setup`, which keeps it in your login
keychain. The Keychain
item keeps the token out of config files, sync and backups. It does **not**
stop another program running as you on this Mac from reading it, because the
item trusts `/usr/bin/security`. Use the read-only connector token, and
regenerate it in Wisply if you suspect malware.

**What your AI app does with what it reads.** Whatever the AI app reads from
Wisply goes to the AI service that app uses, under that service's terms.
Transcripts are recorded speech: treat them as untrusted data.

**Supply chain.** The package has zero runtime dependencies and no lifecycle
scripts (`tests/pack.test.mjs` enforces both). Two things decide which code
your AI app runs under the `wisply` entry:

- **The folder it starts in.** AI apps (Claude Code, Codex, Gemini CLI,
  Cursor, VS Code) start stdio servers in the project you have open, and
  `npx` resolves a package from that folder before it asks npm: a
  `node_modules/@wisply/mcp` anywhere above it (with its `.bin/wisply-mcp`
  link) runs instead of the npm package, with `WISPLY_MCP_TOKEN` in its
  environment, and a project `.npmrc` can point the `@wisply` scope at another
  registry. A cloned repository could bring either. Every snippet and command
  here therefore runs `npx -y --prefix / ...` (`NPX_COMMAND` in
  `lib/constants.mjs`): `npx` then resolves from `/`, the read-only system
  volume on macOS, and installs only from the registry your own `~/.npmrc`
  names. `tests/pack.test.mjs` refuses any `npx` of the package in these
  documents or in `lib/messages.mjs` without those flags. A global install
  (`npm i -g @wisply/mcp@0.1.0`) doesn't read a project's `.npmrc` either.
- **The version.** The snippets in this README (and, once they exist, on
  wisply.ai and in Wisply) run one exact version (`@wisply/mcp@0.1.0`), taken
  from `PACKAGE_SPEC`, and so does `setup`, the command that writes the token
  to your keychain. npm never lets a published version change, so a later
  release, including a bad one, reaches your app only after you change the
  version in its settings. If you write `@wisply/mcp@0` instead, `npx` fetches
  the newest 0.x release every time your app starts the connector: you get
  fixes on their own, and a bad release would run the same way.

`npx` doesn't check npm provenance when it installs a package, so provenance
is an audit trail, not a guard. Publishing is guarded by npm's own controls,
listed under "Release controls" below.

Until the contract with Wisply is final, `package.json` is marked `"private"`,
so `npm publish` refuses the package.

## If you think a token leaked

1. In Wisply, open **Settings > Integrations > MCP Server** and regenerate the
   token (connector, recording or full access). Every client using the old
   token stops working at once.
2. Give the new token to your AI apps again.
3. Turn the MCP server off in Wisply if you don't use it. Wisply stops
   answering MCP requests at once; if Wisply Companion is set up, the same
   local listener stays on for it.

## Release controls (maintainers)

Each of these must hold before the step it names. None is met yet: the
package has never been published. Parts of items 2 and 3 are also
machine-checked: `WISPLY_RELEASE=1 npm test` fails while the contract is
provisional or leaves `setup_claude` non-destructive, and until
`docs/release-checks.json` records the port and registry checks
(`tests/vendor.test.mjs`, `tests/release-checks.test.mjs`).

1. **Before anything public names the package** (the wisply.ai guide,
   Wisply's snippets, catalog listings): the npm organization `wisply` exists,
   with two-factor authentication required for every member, and the unscoped
   fallback name `wisply-mcp` is held by the same owner, so nobody else can
   register either name and be what `npx -y` runs.
2. **Before the first publish:** the contract is re-vendored from wisply-ai
   (`contract/SOURCE.json` no longer provisional, `WISPLY_RELEASE=1 npm test`
   passes), `"private": true` is removed from `package.json` in the same
   change (`tests/pack.test.mjs` ties the two), the `setup`, `status` and
   `forget` commands are in, and the vendored contract marks `setup_claude`
   `destructiveHint: true` (it replaces the Anthropic key stored in Wisply;
   fixed in wisply-ai's `MCPToolCatalog.swift`, never in the vendored JSON).
   `docs/release-checks.json` records `port_exclusive` for the Wisply commit
   the contract is vendored from: either that commit binds the port
   exclusively (`allowLocalEndpointReuse = false`), or a test on a Mac has
   shown that no second socket can listen on Wisply's port while Wisply runs.
3. **Before the first publish, the MCP Registry name.** `package.json`
   `"mcpName"` (`MCP_NAME` in `lib/constants.mjs`, now `ai.wisply/local`) goes
   into the published package and can't change for that version, and the
   registry accepts an `ai.wisply/*` name only from someone who proved control
   of wisply.ai: `mcp-publisher login dns --domain wisply.ai --private-key ...`
   with a `v=MCPv1; k=ed25519; p=<public key>` TXT record on the apex, or
   `mcp-publisher login http` with the same line at
   `https://wisply.ai/.well-known/mcp-registry-auth`. Alex does this (it needs
   the domain and a private key, so no agent can), then records
   `registry_namespace` in `docs/release-checks.json` (`"how": "dns: ..."`).
   If the domain can't be verified, switch `MCP_NAME` and `"mcpName"` to
   `io.github.fal3/wisply-mcp` (verified with `mcp-publisher login github` as
   `fal3`, or as an owner if `fal3` is an organization) before the first
   publish.
4. **The first publish** is by hand, by the organization owner, with
   two-factor authentication.
5. **From the second release,** only npm trusted publishing (OIDC from a
   GitHub Actions release workflow in this repository, behind a protected
   environment) publishes, and the package's publishing access is set to
   "Require two-factor authentication and disallow tokens". This repository
   has no release workflow yet; until it does, no release claims provenance.
6. **Every release** bumps `version` in `package.json` and `VERSION` in
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
