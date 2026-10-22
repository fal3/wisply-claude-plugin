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
logged, and every line is also scrubbed of anything shaped like a token. An
argument (or `WISPLY_MCP_PORT`) that looks like a token, or part of one, is
refused with a fixed message that echoes none of it, because an AI app keeps
the connector's stderr in its log files.

**The token at rest.** Don't put a token in an AI app's config file: those
files end up in Settings Sync, dotfile repositories and backups. Run
`npx -y --prefix / @wisply/mcp@0.1.0 setup`, which keeps it in your login
keychain, or let the app's secret storage pass it as `WISPLY_MCP_TOKEN`.

- The item is a generic password: service `ai.wisply.mcp`, account `token`,
  label "Wisply MCP token", trusting `/usr/bin/security` only (`-T`, never
  `-A`). `setup` first removes every item with that service and account, then
  creates a new one without `-U`: `add-generic-password -U` on an existing item
  would keep that item's access list and only merge `-T` into it, so an item
  made earlier by another tool could keep trusting other programs.
- The item goes to your default keychain, normally the login keychain
  (`add-generic-password` can't name a keychain while it prompts for the
  password). Reads and deletes search your keychain search list, and `forget`
  (like `setup`) repeats the delete until no copy is left, so a second copy in
  another keychain can't keep answering after a successful `forget`.
- The connector reaches it only through `/usr/bin/security`, by absolute path,
  with fixed arguments and this process's environment minus every
  `WISPLY_MCP_*` variable, so a token set in `WISPLY_MCP_TOKEN` never reaches
  the child. `setup` lets `security` prompt for the token in the terminal
  (`-w` as the last argument), so the token is never in an argument list, a
  process listing or the connector's output. Reads come back through a pipe
  and are given up after 2 seconds (a locked keychain or an unanswered macOS
  dialog then counts as "no token").
- `setup` reads the item back once and removes it again when it isn't a Wisply
  token or is the full-access token without `--full-access`. `status` never
  prints the token. `forget` removes the item.
- A full-access token in the keychain reaches every AI app on this Mac that
  starts the connector without its own `WISPLY_MCP_TOKEN` (Cursor, Windsurf,
  Zed, Codex, one-click links), each with recording control and follow-ups and
  no opt-in of its own. `setup --full-access` and `status` say so.

The Keychain item keeps the token out of config files, sync and backups. It
does **not** stop another program running as you on this Mac from reading it,
because the item trusts `/usr/bin/security`. Use the read-only connector
token, and regenerate it in Wisply if you suspect malware.

**Setting up apps.** The app setups (`print-config`, `install`, and the
copies in Wisply and on wisply.ai, all from `clients/mcp-clients.json`) hold
no token and can't: their only placeholders are the connector's arguments,
and `tests/clients.test.mjs` refuses token prefixes, `Bearer`,
`Authorization`, headers and direct HTTP to the port. `install` never reads
the token or the Keychain item, and never writes a token anywhere. Until the
release, `print-config <app>` and `install` print and write nothing, and
`render()` and `installPlan()` throw for any program that bundles
`lib/clients.mjs`: an entry written before then would run `npx -y` of a name
someone else could still register, every time the app starts it.

- An app's own command (`claude`, `codex`, `gemini`, `code`) is found in
  `PATH`'s absolute folders only (an empty or relative entry such as `.`
  would pick up a program from the folder install runs in, a cloned project
  for example) and started by that absolute path with `execFile`, a fixed
  argument list and no shell, in an environment without `WISPLY_MCP_TOKEN`,
  any other value shaped like a token, or relative `PATH` entries.
- In a JSON settings file, install reads the file but changes only the text of
  the `wisply` entry: every other byte stays, so other servers' values (and
  any secrets in them) are kept exactly. It refuses JSONC (comments), repeated
  keys and text that isn't UTF-8, and gives up if the file changes while it
  works (an app saving its settings). The new text goes to a temporary file
  with mode 0600, which gets the file's own mode just before the rename. A
  file with a second hard link is refused: the rename would leave the other
  link with the old text, token included.
- An app's override variable for its settings file (`CLINE_MCP_SETTINGS_PATH`,
  `CLINE_DATA_DIR`, `CLINE_DIR`, `COPILOT_HOME`) counts only as a full path.
  Anything else would be resolved against the folder install or the app runs
  in, so install changes nothing and prints the snippet.
- The one-time backup `<file>.wisply-backup` is a new file with mode 0600,
  and every Wisply token in it is masked (`wsp...`), so install never makes a
  second copy of a token, even next to a file in a dotfiles repository.
  Other servers' keys and tokens stay in it as they were in the file; install
  says so, and to delete the backup once the app works. When
  the old `wisply` entry held a Wisply token in plain text (as the direct-HTTP
  setups that Wisply's own Copy buttons produce until a release switches them
  to this connector do), install replaces it and says so: regenerate the token
  if the file was ever synced or shared. Of the old entry, only fields the
  app or you own (`autoApprove`, `disabled`, `timeout`, `tools` and the like)
  stay, and never one that holds something token-shaped.

**What your AI app does with what it reads.** Whatever the AI app reads from
Wisply goes to the AI service that app uses, under that service's terms.
`print-config` and `install` say so when they set an app up.
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
  from `PACKAGE_SPEC`, and so do the `setup`, `status` and `forget` commands
  the connector's messages name once the npm name is Wisply's (`setup` is the
  command that writes the token to your keychain). npm never lets a published
  version change, so a later release, including a bad one, reaches your app
  only after you change the version in its settings. If you write
  `@wisply/mcp@0` instead, `npx` fetches the newest 0.x release every time
  your app starts the connector: you get fixes on their own, and a bad release
  would run the same way.

`npx` doesn't check npm provenance when it installs a package, so provenance
is an audit trail, not a guard. Publishing is guarded by npm's own controls,
listed under "Release controls" below.

**Where npx finds the package.** `npx` uses a copy of the package that is
already in the folder it starts in (its `node_modules`) before it asks the
registry, and it reads that folder's `.npmrc`, which can point the `@wisply`
scope at another registry. AI apps (Claude Code, Cursor, VS Code and others)
start stdio servers in the project you have open, and they start an entry
from your user settings without asking again. So a cloned repository holding
`node_modules/@wisply/mcp` at the pinned version, or such an `.npmrc`, would
run its own code as the connector as soon as you opened it, with access to
the Keychain item (which trusts `/usr/bin/security`, see above) and your
transcripts. Every setup and every command in these docs therefore runs
`npx -y --prefix / @wisply/mcp@<version>`: with `--prefix /`, npx resolves the
package and reads the project config from `/`, the read-only system volume
on macOS, and gets the package from the registry in your own `~/.npmrc`
(`tests/clients.test.mjs` refuses any setup without it). The strongest setup
skips npx: `npm i -g @wisply/mcp@0.1.0` once, then the absolute path of
`wisply-mcp` as the app's command. Whether each app starts `npx --prefix /`
cleanly is part of the Mac QA before the release.

Until the contract with Wisply is final, `package.json` is marked `"private"`,
so `npm publish` refuses the package. Until the npm name is Wisply's
(`PACKAGE_NAME_FINAL` in `lib/constants.mjs`, tied to `"private"` by
`tests/pack.test.mjs`), the connector's messages never name the package: tool
errors, which the model also reads, point only at `WISPLY_MCP_TOKEN`, and
terminal messages name the bin (`wisply-mcp setup`). Nobody, person or agent,
is told to `npx` a name someone else could register first.

## If you think a token leaked

1. In Wisply, open **Settings > Integrations > MCP Server** and regenerate the
   token (connector, recording or full access). Every client using the old
   token stops working at once.
2. Run `npx -y --prefix / @wisply/mcp@0.1.0 setup` again with the new token,
   or give it to the AI apps that keep it themselves.
   `npx -y --prefix / @wisply/mcp@0.1.0 forget` removes the saved token if you
   don't need it any more.
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
   Wisply's snippets, catalog listings, the connector's own messages): the npm
   organization `wisply` exists, with two-factor authentication required for
   every member, and the unscoped fallback name `wisply-mcp` is held by the
   same owner, so nobody else can register either name and be what `npx -y`
   runs. Until then `clients/mcp-clients.json` says `"published": false`, and
   its copies in wisply-ai and wisply-web render nothing from it.
2. **Before the first publish:** the contract is re-vendored from wisply-ai
   (`contract/SOURCE.json` no longer provisional, `WISPLY_RELEASE=1 npm test`
   passes), `"private": true` is removed from `package.json`,
   `PACKAGE_NAME_FINAL` becomes `true` and `"published"` becomes `true` in
   `clients/mcp-clients.json` in the same change (`tests/pack.test.mjs` and
   `tests/clients.test.mjs` tie all four), `setup`, `status` and `forget` have
   passed the manual Keychain QA on a Mac (below), each app in the install
   list has started `npx -y --prefix / ...` on a Mac, and the vendored contract
   marks `setup_claude` `destructiveHint: true` (it replaces the Anthropic key
   stored in Wisply; fixed in wisply-ai's `MCPToolCatalog.swift`, never in the
   vendored JSON). `docs/release-checks.json` records `port_exclusive` for the
   Wisply commit the contract is vendored from: either that commit binds the
   port exclusively (`allowLocalEndpointReuse = false`), or a test on a Mac
   has shown that no second socket can listen on Wisply's port while Wisply
   runs.

   Manual Keychain QA, from a checkout (`node bin/wisply-mcp.mjs ...`):
   - `setup` with the connector token: one item, and
     `security dump-keychain -a ~/Library/Keychains/login.keychain-db` lists
     only `/usr/bin/security` among its trusted applications. No macOS access
     dialog appears.
   - First create an item with the same service and account and `-A`
     (`security add-generic-password -s ai.wisply.mcp -a token -A -w <synthetic>`),
     then run `setup`: the old item is gone and the new one trusts only
     `/usr/bin/security`.
   - Cancel `setup` at the first prompt (Ctrl-C), with and without an item
     saved before: the message matches what is left.
   - Put a second copy in another keychain on the search list, then run
     `forget`: both go, and `status` reports no token.
   - `setup --full-access` and `status` with that item print the full-access
     note; `WISPLY_MCP_PORT=eighty forget` still removes the item.
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
   `lib/constants.mjs` together, with every `@wisply/mcp@<version>` in
   `clients/mcp-clients.json` (`package_spec`, `standard_entry` and the
   `vscode-inputs` text; `tests/clients.test.mjs` ties them). The
   snippets follow `PACKAGE_SPEC`; copy the clients file on to wisply-ai and
   wisply-web, so the wisply.ai guide and Wisply's snippets name the new
   version.

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
