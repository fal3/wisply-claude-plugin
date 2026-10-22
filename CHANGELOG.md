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
  which contain the token or the app's response. Until the npm name is
  Wisply's (`PACKAGE_NAME_FINAL`), they point only at `WISPLY_MCP_TOKEN`; from
  then on also at `npx -y --prefix / @wisply/mcp@0.1.0 setup`. A missing
  recording-control proof says that Wisply may be too old or may have failed
  to read that token.
- A JSON-RPC error from Wisply keeps its code, with a fixed message from the
  connector in place of Wisply's own text.
- `setup [--full-access]`: removes every "Wisply MCP token" item saved
  before, then macOS's `security` asks for the token in the terminal and
  stores it in the login keychain ("Wisply MCP token"; service
  `ai.wisply.mcp`, account `token`; created without `-U`, trusting only
  `/usr/bin/security`), so the token never passes through the connector's
  arguments or output. Setup reads it back once, removes a full-access token
  unless `--full-access` and anything that isn't a Wisply token, and runs the
  identity check on what it keeps. A stored full-access or recording-control
  token comes with a note that it reaches every AI app without its own token
  (full access, or starting and stopping recordings while Wisply allows
  agents to). It needs a terminal.
- `status`: where the token comes from (environment or Keychain, and whether
  a placeholder was ignored), its scope, the port (also without a token),
  whether Wisply answered and proved it holds the token (or answered that it
  couldn't read its own tokens from the Keychain), and the tool count ("none"
  for `--read-only` with a recording-control token), with the same note for a
  full-access or recording-control token in the keychain. It never prints the
  token.
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
  pinned version from `/` (`npx -y --prefix / @wisply/mcp@0.1.0 setup`), like
  the snippets, once the npm name is Wisply's; until then they are
  `wisply-mcp setup`, `wisply-mcp status` and `wisply-mcp forget`.
- Without a usable `WISPLY_MCP_TOKEN`, the connector reads the Keychain item
  (macOS only, 2 s budget).
- `print-config` and `install` answer "not in this build yet" (exit 1) and
  point at the guide's standard entry and `setup`, never at putting the token
  in an app's config file.
- Snippets and commands run `npx -y --prefix / @wisply/mcp@0.1.0`: the exact
  version (`@wisply/mcp@0` is an opt-in for automatic 0.x updates), resolved
  from `/` so the open project's `node_modules` and `.npmrc` can't supply
  another copy.
- The token from `WISPLY_MCP_TOKEN`; empty values and unresolved `${...}`
  placeholders count as unset and fall through to the Keychain item.
- `WISPLY_MCP_DEBUG=1`: one fixed-field line per request on stderr, never
  arguments, results or tokens.
- `--help` and `--version`.
- `npm run sync-vendor` reads and checks every upstream file before it
  writes anything, and refuses a missing file or a contract the connector
  can't load.
- `WISPLY_RELEASE=1 npm test` also requires the release checks in
  `docs/release-checks.json` (the Mac port test, the MCP Registry namespace,
  Wisply's npm name), `PACKAGE_NAME_FINAL` with no `"private"` in
  `package.json`, and a destructive `setup_claude` in the contract.
  `PACKAGE_NAME_FINAL` follows the recorded npm name (`npm_scope`), never the
  contract, so re-vendoring the contract can't make the connector's messages
  name an npm package nobody owns yet.

### Differences from the distribution design

`docs/design-differences.md` lists every place this package departs from
the distribution design, for the bridge (exact versions, `--prefix /`, the
Keychain and scope texts, the release checks) and for setup, status and
forget (no package name before it is Wisply's, `SETUP_MALFORMED`, replace
instead of update, every copy removed, the full-access and recording notes,
`forget` off macOS, exit codes, the impostor in manual QA 2), so they can be
folded into the spec.

### Not yet

- The contract is provisional (transcribed from Wisply's tool catalog), and
  the npm name isn't Wisply's yet, so `package.json` is `"private"` and npm
  refuses to publish it until the contract is re-vendored from wisply-ai
  (DIST-M5) and `npm_scope` is recorded (Alex, after the npm organization
  exists). `WISPLY_RELEASE=1 npm test` fails on purpose until then and until
  `docs/release-checks.json` records the other release checks; the ordinary
  `npm test` checks that it does.
- `print-config` and `install`.
