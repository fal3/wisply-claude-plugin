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
  They point at `npx -y @wisply/mcp setup` and at `WISPLY_MCP_TOKEN`.
- A JSON-RPC error from Wisply keeps its code, with a fixed message from the
  connector in place of Wisply's own text.
- `setup [--full-access]`: macOS's `security` asks for the token in the
  terminal and stores it in the login keychain ("Wisply MCP token"; service
  `ai.wisply.mcp`, account `token`), so the token never passes through the
  connector's arguments or output. Setup reads it back once, removes a
  full-access token unless `--full-access` and anything that isn't a Wisply
  token, and runs the identity check on what it keeps. It needs a terminal.
- `status`: where the token comes from (environment or Keychain, and whether
  a placeholder was ignored), its scope, the port, whether Wisply answered and
  proved it holds the token, and the tool count. It never prints the token.
- `forget`: removes the Keychain item.
- Without a usable `WISPLY_MCP_TOKEN`, the connector reads the Keychain item
  (macOS only, 2 s budget).
- `print-config` and `install` answer "not in this build yet" (exit 1).
- Snippets pin the exact version (`@wisply/mcp@0.1.0`); `@wisply/mcp@0` is an
  opt-in for automatic 0.x updates.
- The token from `WISPLY_MCP_TOKEN`; empty values and unresolved `${...}`
  placeholders count as unset and fall through to the Keychain item.
- `WISPLY_MCP_DEBUG=1`: one fixed-field line per request on stderr, never
  arguments, results or tokens.
- `--help` and `--version`.

### Added outside the npm package

These live in the repository, not in the package:

- The Agent Plugin (`plugin.json`, `mcp.json`, Agent Plugins 1.0.0) for
  Codex, Cursor, VS Code and GitHub Copilot CLI, with a Codex marketplace
  (`.agents/plugins/marketplace.json`). It runs the repository's copy of the
  connector with `node`, never `npx`.
- The Gemini CLI extension (`gemini-extension.json`): the token as an
  optional sensitive setting, and the commands `/wisply:recap`,
  `/wisply:live` and `/wisply:find`.
- The portable skill `skills/wisply-memos/SKILL.md` (Agent Skills), and an
  optional Cursor rule and command in `extras/cursor/`.
- The Claude Desktop bundle source (`mcpb/manifest.json`, MCPB 0.3, with an
  optional masked token field that defaults to empty, so an empty field
  uses the token saved by `setup`) and `npm run build:mcpb`.
- MCP Registry entries `server.json` (`ai.wisply/local`: the npm package and
  the bundle) and `registry/cloud.server.json` (`ai.wisply/cloud`, for Cloud
  Connect), `glama.json` and `llms-install.md`.
- The README's install matrix: one-click links for Cursor, VS Code, VS Code
  Insiders, Goose, LM Studio and Kiro, and the setup for 20 apps.

### Not yet

- The contract is provisional (transcribed from Wisply's tool catalog), so
  `package.json` is `"private"` and npm refuses to publish it until the
  contract is re-vendored from wisply-ai.
- `print-config` and `install`.
- The bundle's `fileSha256` in `server.json` is a placeholder until the
  release asset exists; `WISPLY_REGISTRY_RELEASE=1 npm test` refuses it.
