# Changelog

All notable changes to `@wisply/mcp` are listed here. Versions follow
[Semantic Versioning](https://semver.org/). A release's heading gets its date
in the change that prepares the release; `WISPLY_RELEASE=1 npm test` refuses
to release a version whose heading has none.

## 0.1.0 - Unreleased

The first release: the connector, its setup commands and the setups for 20
AI apps, plus the Agent Plugin, Gemini CLI extension, Claude Desktop bundle,
registry entries and skill built from this repository.

### Added: the connector

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

### Added in this repository (not in the npm package)

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
- The release workflow `.github/workflows/release.yml`, for the releases
  after 0.1.0 (0.1.0 itself is published by hand): only for `v*` tags, only
  while the repository is public and the variable `NPM_TRUSTED_PUBLISHING`
  is `on`, behind the `release` environment; npm trusted publishing (OIDC,
  no npm token, `id-token: write` on that one job); actions pinned to full
  commit SHAs; npm 11.21.0 installed without scripts; `npm run check` and
  `WISPLY_RELEASE=1 npm test`; then `npm stage publish --provenance`, so a
  version goes live only after a maintainer approves it on npm with
  two-factor authentication.
- The release gate `WISPLY_RELEASE=1 npm test` (`tests/release.test.mjs`):
  it refuses a provisional contract, a package that is still `"private"`, a
  package name that isn't final, a clients file that isn't `"published"`, a
  CHANGELOG heading without this version's date and, in the release
  workflow, a tag other than `v<version>`.
- `npm run sync-vendor` refuses a wisply-ai contract the connector can't
  load (for example one with `tool_descriptors` but no `wspr_` scope, or the
  other way round) before it writes anything.

### Known limitations

- The contract is provisional (transcribed from Wisply's tool catalog at
  wisply-ai 885cc75): wisply-ai's `Docs/mcp-contract.json` isn't on its
  `main` yet, and it needs both raycast PR 1 (the `wspr_` scope, error
  codes, `tail_words`) and DIST-A1 (`tool_descriptors`). Until it is
  re-vendored and the npm name is Wisply's, `package.json` stays
  `"private"` and npm refuses to publish the package.
- The bundle's `fileSha256` in `server.json` is a placeholder until the
  release asset exists; `WISPLY_REGISTRY_RELEASE=1 npm test` refuses it.
- `setup_claude` (only with `--allow-claude-setup`): in Wisply builds without
  DIST-A1's change, its answer includes a Cursor snippet with the full-access
  token, and the connector passes it on unchanged. Leave the switch off until
  every Wisply you use has that change; SECURITY.md says so.
- `/wisply:live` reads the whole live transcript until the contract is
  re-vendored with `tail_words` (see the design differences).

Differences from the distribution design, to fold into the spec, are listed
in [docs/design-differences.md](docs/design-differences.md).
