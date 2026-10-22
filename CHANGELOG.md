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
  `WISPLY_MCP_TOKEN`; from then on also at `npx -y @wisply/mcp@0.1.0 setup`.
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
  pinned version (`npx -y @wisply/mcp@0.1.0 setup`), like the snippets.
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

### Differences from the distribution design (to fold into the spec)

- **Pinned commands.** The design's texts name the setup, status and forget
  commands with the bare package name, without a version. This package names
  them with `PACKAGE_SPEC` (`npx -y @wisply/mcp@0.1.0 setup`), as it already
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

### Not yet

- The contract is provisional (transcribed from Wisply's tool catalog), so
  `package.json` is `"private"` and npm refuses to publish it until the
  contract is re-vendored from wisply-ai.
- `print-config` and `install`.
