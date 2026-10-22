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
  answering, identity check failed, Wisply too old, Wisply unable to read its
  tokens from the Keychain, tool outside the scope, another platform), none of
  which contain the token or the app's response. Until `setup` exists they
  point only at `WISPLY_MCP_TOKEN`. A missing recording-control proof says
  that Wisply may be too old or may have failed to read that token.
- A JSON-RPC error from Wisply keeps its code, with a fixed message from the
  connector in place of Wisply's own text.
- `setup`, `status`, `forget`, `print-config` and `install` answer "not in
  this build yet" (exit 1).
- Snippets and commands run `npx -y --prefix / @wisply/mcp@0.1.0`: the exact
  version (`@wisply/mcp@0` is an opt-in for automatic 0.x updates), resolved
  from `/` so the open project's `node_modules` and `.npmrc` can't supply
  another copy. The future `setup` command is pinned the same way.
- The token from `WISPLY_MCP_TOKEN`; empty values and unresolved `${...}`
  placeholders count as unset.
- `WISPLY_MCP_DEBUG=1`: one fixed-field line per request on stderr, never
  arguments, results or tokens.
- `--help` and `--version`.

- `npm run sync-vendor` reads and checks every upstream file before it
  writes anything, and refuses a missing file or a contract the connector
  can't load.
- `WISPLY_RELEASE=1 npm test` also requires the release checks in
  `docs/release-checks.json` (the Mac port test, the MCP Registry namespace)
  and a destructive `setup_claude` in the contract.

### Not yet

- The contract is provisional (transcribed from Wisply's tool catalog), so
  `package.json` is `"private"` and npm refuses to publish it until the
  contract is re-vendored from wisply-ai.
- `setup`, `status` and `forget` (the macOS Keychain token), `print-config` and
  `install`.
