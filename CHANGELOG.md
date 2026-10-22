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
  They point at `npx -y --prefix / @wisply/mcp@0.1.0 setup` and at
  `WISPLY_MCP_TOKEN`.
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

### Not yet

- The contract is provisional (transcribed from Wisply's tool catalog), so
  `package.json` is `"private"` and npm refuses to publish it until the
  contract is re-vendored from wisply-ai.
