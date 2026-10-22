# Changelog

All notable changes to `@wisply/mcp` are listed here. Versions follow
[Semantic Versioning](https://semver.org/).

## Unreleased

### Added

- A stdio MCP server (`wisply-mcp`) that bridges any MCP client to the Wisply
  app on this Mac at `127.0.0.1:51771` (`--port` / `WISPLY_MCP_PORT` for
  another port).
- An identity check before every use of the token: Wisply proves, with an
  HMAC over a fresh nonce bound to the port, that it holds the same token, for
  the token's own scope (`wsp_`, `wspc_` and `wspr_`).
- `tools/list` from the vendored Wisply contract, never from the port: the
  tools the token's scope reaches, in contract order; the four read-only tools
  when no token is set; `setup_claude` only with `--allow-claude-setup`;
  `--read-only` to offer only the read-only tools.
- Plain tool errors for every failure (token not set or malformed, Wisply not
  answering, identity check failed, Wisply too old, tool outside the scope,
  another platform), none of which contain the token or the app's response.
  Until the npm name is Wisply's (`PACKAGE_NAME_FINAL`), they point only at
  `WISPLY_MCP_TOKEN`; from then on also at
  `npx -y --prefix / @wisply/mcp@0.1.0 setup`.
- A JSON-RPC error from Wisply keeps its code, with a fixed message from the
  connector in place of Wisply's own text.
- `setup [--full-access]`: removes every "Wisply MCP token" item saved
  before, then macOS's `security` asks for the token in the terminal and
  stores it in the login keychain ("Wisply MCP token"; service
  `ai.wisply.mcp`, account `token`; created without `-U`, trusting only
  `/usr/bin/security`), so the token never passes through the connector's
  arguments or output. Setup reads it back once, removes a full-access token
  unless `--full-access` and anything that isn't a Wisply token, and runs the
  identity check on what it keeps. A stored full-access token comes with a
  note that it reaches every AI app without its own token. It needs a
  terminal.
- `status`: where the token comes from (environment or Keychain, and whether
  a placeholder was ignored), its scope, the port (also without a token),
  whether Wisply answered and proved it holds the token, and the tool count
  ("none" for `--read-only` with a recording-control token). It never prints
  the token.
- `forget`: removes the Keychain item, every copy in the keychain search
  list. It ignores `WISPLY_MCP_PORT`. Off macOS there is nothing saved (setup
  refuses there), so it says so and exits 0.
- Exit codes for setup, status and forget: 0 done (status: a token was found
  and Wisply proved it holds it), 1 a problem the message names, 2 a usage
  mistake (an unknown option, a token passed as an argument).
- `security` runs with the environment minus every `WISPLY_MCP_*` variable.
- An argument or `WISPLY_MCP_PORT` that looks like a token is refused with a
  fixed message that shows none of it.
- The setup, status and forget commands that messages and docs name run the
  pinned version after npx's flags (`npx -y --prefix / @wisply/mcp@0.1.0 setup`),
  like the snippets.
- Without a usable `WISPLY_MCP_TOKEN`, the connector reads the Keychain item
  (macOS only, 2 s budget).
- `print-config [<app>] [--port <n>]`: the token-free setup for 20 AI apps
  (Claude Code, Claude Desktop, Cursor, VS Code, Windsurf, Zed, JetBrains AI
  Assistant, Codex, Gemini CLI, GitHub Copilot CLI, Warp, Cline, Roo Code,
  Goose, LM Studio, Kiro, opencode, Amp, Factory, Grok CLI) from
  `clients/mcp-clients.json`, the source the Wisply app and wisply.ai copy.
  The snippet goes to stdout and where it goes to stderr; with no app, the
  list. The file says `"published": false` until the package is on npm, and
  its copies render nothing while it does.
- `install <app> [--port <n>]`: runs `claude mcp add`, `codex mcp add`,
  `gemini mcp add` (arguments after `--`) or `code --add-mcp`, found by
  absolute path in `PATH`'s absolute folders, with a fixed argument list and
  without the token or relative `PATH` entries in their environment. For
  Cursor, Windsurf, Claude Desktop, the Cline CLI and GitHub Copilot CLI it
  changes only the text of the `wisply` entry in their JSON settings (every
  other byte of the file stays), after a one-time `<file>.wisply-backup`
  (mode 0600, Wisply tokens masked), with an atomic write that follows
  symlinks and gives up if the app wrote the file meanwhile. It refuses JSONC,
  repeated keys and non-UTF-8 text (Zed's and VS Code's JSONC settings are
  never edited), never reads or writes a token, and warns when the entry it
  replaced held one in plain text.
- Snippets and every command in the docs and messages run the exact version
  with `npx -y --prefix / @wisply/mcp@0.1.0`: the version can't change under
  you, and `--prefix /` stops npx from running a copy of the package (or
  reading an `.npmrc`) from the project folder an app starts it in.
  `@wisply/mcp@0` is an opt-in for automatic 0.x updates.
- The token from `WISPLY_MCP_TOKEN`; empty values and unresolved `${...}`
  placeholders count as unset and fall through to the Keychain item.
- `WISPLY_MCP_DEBUG=1`: one fixed-field line per request on stderr, never
  arguments, results or tokens.
- `--help` and `--version`.

### Differences from the distribution design (to fold into the spec)

- **Pinned commands.** The design's texts name the setup, status and forget
  commands with the bare package name, without a version. This package names
  them with `PACKAGE_SPEC` after npx's flags
  (`npx -y --prefix / @wisply/mcp@0.1.0 setup`), as it already
  does for every snippet, so the command that decides which token lands in
  the keychain never runs npm's newest release. The "Errors" texts are
  otherwise word for word.
- **No package name before it is Wisply's.** While `PACKAGE_NAME_FINAL` is
  false, `SETUP`, `MALFORMED` and `NOT_WISPLY` in tool results use the interim
  wording that names only `WISPLY_MCP_TOKEN`, and terminal texts (setup,
  status, forget, argument errors) name `wisply-mcp setup`.
- **`SETUP_MALFORMED`.** When setup's read-back isn't a Wisply token it prints
  `SETUP_MALFORMED`, not the design's `MALFORMED` (which says
  "WISPLY_MCP_TOKEN is set", wrong in setup): "That isn't a Wisply token (it
  should start with wspc_, wspr_ or wsp_ and have 64 hex characters), so it
  wasn't saved. Copy the read-only connector token from Wisply > Settings >
  Integrations > MCP Server and run `{setup command}` again." The VS Code
  extension and the wisply.ai page should use the same text.
- **Setup replaces instead of updating.** Setup deletes every earlier item
  before `security` asks for the token, and adds without `-U`, so the item's
  access list is always the documented one. Cancelling after that leaves no
  item, and setup says so (`SETUP_CANCELLED_AFTER_REMOVAL`, `PREVIOUS_REMOVED`);
  `SETUP_CANCELLED` ("Your login keychain wasn't changed") is printed only
  when there was nothing to remove.
- **Full-access note.** `setup --full-access` (`FULL_ACCESS_SHARED`) and
  `status` with a full-access keychain item say that every AI app without its
  own token gets full access.
- **`forget` off macOS.** The design leaves it open. `forget` prints its own
  text (`nothingSavedOffMac`: "This connector saves a token only in the macOS
  Keychain, and this computer runs {platform}, so there's nothing to
  remove.") and exits 0, instead of `NOT_MAC` and exit 1: setup refuses off
  macOS, so no saved copy can exist. `setup` and `status` keep `NOT_MAC` and
  exit 1 there, as the design says for status.
- **`WISPLY_RELEASE=1 npm test` fails on purpose until DIST-M5.** Exactly one
  test fails ("a provisional contract is never released"), and the ordinary
  `npm test` checks that it does. It belongs to the release check (DIST-M5),
  not to `npm run check`.

### Added outside the npm package

These live in the repository, not in the package:

- The Agent Plugin (`plugin.json`, `mcp.json`, Agent Plugins 1.0.0) for
  Codex, Cursor, VS Code and GitHub Copilot CLI, with a Codex marketplace
  (`.agents/plugins/marketplace.json`). It runs the repository's copy of the
  connector with `node`, never `npx`.
- The Gemini CLI extension (`gemini-extension.json`): the token as an
  optional sensitive setting that recommends the read-only token and says
  what a full-access one allows, and the commands `/wisply:recap`,
  `/wisply:live` and `/wisply:find`.
- The portable skill `skills/wisply-memos/SKILL.md` (Agent Skills), and an
  optional Cursor rule and command in `extras/cursor/`.
- The Claude Desktop bundle source (`mcpb/manifest.json`, MCPB 0.3, with an
  optional masked token field that defaults to empty, so an empty field
  uses the token saved by `setup`, and the tools the bundle can serve: every
  contract tool but `setup_claude`) and `scripts/build-mcpb.mjs`:
  `npm run build:mcpb` is the release build (a clean checkout at tag
  `v<version>` only; it stages the tag's files, packs the bundle and writes
  `SHA256SUMS`), `--unreleased` packs a test bundle from any checkout under a
  name no release gate accepts, and only files git tracks reach a bundle.
- The pinned MCPB packer in `tools/mcpb` (`@anthropic-ai/mcpb` 2.1.2 and a
  committed lockfile with integrity hashes for every dependency), installed
  with `npm ci --ignore-scripts --prefix tools/mcpb` in CI and for releases;
  nothing runs `npx` to pack.
- The release gate `WISPLY_MCPB_FILE` also unpacks the bundle and compares
  every file with the release tag, byte for byte.
- MCP Registry entries `server.json` (`ai.wisply/local`: the npm package and
  the bundle) and `registry/cloud.server.json` (`ai.wisply/cloud`, for Cloud
  Connect), `glama.json` and `llms-install.md`.
- The README's install matrix: one-click links for Cursor, VS Code, VS Code
  Insiders, Goose, LM Studio and Kiro, the setup for 20 apps, and
  tag-pinned git installs (`--ref v0.1.0`) for Codex and Gemini CLI.

### Differences from the distribution design: plugins, extensions and the bundle (to fold into the spec)

- **`/wisply:live` hedges `tail_words`.** The design has `live.toml` call
  `get_live_transcript` with `tail_words` 400. The provisional contract's
  `get_live_transcript` takes no arguments (`additionalProperties: false`),
  and a model calls tools by their schema (Gemini CLI may also check
  arguments against it), so the prompt passes `tail_words` 400 only "if the
  tool accepts tail_words, otherwise with no arguments". Until raycast PR 1's
  contract is vendored, `/wisply:live` reads the whole live transcript.
  `tests/skills.test.mjs` fails once the contract has `tail_words` and the
  hedge is still there, so the DIST-M5 re-vendor makes the call
  unconditional.
- **The remote is its own plugin.** The design's directory table and
  DIST-M6 row add a second `mcp.json` entry, `wisply-cloud`
  (streamable-http), to the root plugin. The root `mcp.json` stays
  local-only instead (`tests/manifests.test.mjs` refuses any non-stdio, URL,
  header or env entry in it), and the remote is the separate, opt-in Agent
  Plugin at `cloud-connect/plugin`, listed as a second marketplace entry
  (as DIST-M6 builds it).
- **Exact versions.** Snippets, one-click links and the versions note name
  `@wisply/mcp@0.1.0` (`PACKAGE_SPEC`); `@wisply/mcp@0` is only the opt-in
  (DIST-M1). The design's standard entry, per-client snippets, deeplinks and
  the W1 versions-note text still say `@0`, and DIST-M4's templates, the W1
  page and DIST-A1's Swift snippets should follow the exact version.
- **No `setup_claude` in the bundle's tools.** The bundle never passes
  `--allow-claude-setup`, so its manifest (which Claude's directory and
  Smithery read) lists the eight tools it can serve.
- **Token fields say what a full-access token allows.** The connector accepts
  any Wisply token from `WISPLY_MCP_TOKEN`, so the bundle's and the Gemini
  extension's token fields recommend `wspc_` and say that a `wsp_` token lets
  the AI app start and stop recordings and propose follow-ups.
- **Two release assets.** Every release carries the bundle and
  `SHA256SUMS`, and the notes repeat its line. Gemini CLI installs a GitHub
  repository from its newest release: with exactly one asset whose name has
  no platform in it, it takes that asset for the extension and fails to
  unpack a `.mcpb`; with two, it uses the tag's source archive.
- **Release build.** The design packs with
  `npx -y @anthropic-ai/mcpb@2.1.2`; the release build and CI use the copy
  installed from `tools/mcpb`'s lockfile instead, refuse a checkout that
  isn't clean or isn't at the tag, and stage the tag's own files. The gate
  runs on the asset downloaded back from the draft release and compares its
  contents with the tag, not only its sha256.
- **Git installs and `main`.** Git-sourced installs (Agent Plugin, Gemini
  extension) follow the default branch unless they name a ref, so the README
  gives `--ref v<version>` where the app takes one (Codex, Gemini CLI;
  GitHub Copilot CLI's `plugin install` and VS Code's **Install Plugin From
  Source** take none), and the release controls add a `main` ruleset (pull
  requests with CI only, no force-push or deletion, signed commits) to the
  design's `v*` tag ruleset and immutable releases.

### Not yet

- The contract is provisional (transcribed from Wisply's tool catalog), so
  `package.json` is `"private"` and npm refuses to publish it until the
  contract is re-vendored from wisply-ai.
- The bundle's `fileSha256` in `server.json` is a placeholder until the
  release asset exists; `WISPLY_REGISTRY_RELEASE=1 npm test` refuses it.
- `setup_claude` (only with `--allow-claude-setup`): Wisply's answer includes
  a Cursor snippet with its full-access token, and the connector passes it on
  unchanged. Until Wisply returns a placeholder there (or the connector
  redacts token-shaped text in results), leave the switch off; SECURITY.md
  says so.
