# Differences from the distribution design

Where this repository departs from the distribution lane's design
(`2026-10-21-distribution-design.md`), and why, so the spec can be updated.
Later lanes (DIST-M2 to M5, the VS Code extension's vendored copy, DIST-A1,
DIST-A2, DIST-W1) should code against this list where it differs from the
spec text. Not shipped in the npm package.

## The bridge (DIST-M1)

- **Exact versions (spec D3, the constants row, "Versions", the per-client
  table, risk 25).** The design has snippets run `@wisply/mcp@0`, the newest
  0.x release at every start. Here `PACKAGE_SPEC` is the exact version
  (`@wisply/mcp@0.1.0`, following `VERSION`), and `PACKAGE_RANGE`
  (`@wisply/mcp@0`) is only an opt-in the README and SECURITY.md describe,
  never a snippet. npm never changes a published version, so a bad 0.x
  publish (a hijacked account, a mistake) doesn't reach installed clients on
  its own. The cost: users move to a fix only when the snippet they copy
  changes, so every release updates the wisply.ai guide and Wisply's
  snippets. Decision for the spec's Risks & decisions table: "D3 revised:
  snippets pin the exact version; `@0` is an opt-in."
- **`npx -y --prefix /` (security finding of the M1 review).** The design's
  standard entry is `["-y", "@wisply/mcp@0"]`. Claude Code, Codex, Gemini
  CLI, Cursor and VS Code start stdio servers in the open project, and npx
  resolves the package from that folder first: a planted
  `node_modules/@wisply/mcp` (version 0.1.0 with its `.bin/wisply-mcp` link)
  ran instead of the npm package and received `WISPLY_MCP_TOKEN`, from the
  project root and from a subfolder, with or without a `package.json`
  (reproduced on npm 10.9.4); a project `.npmrc` that points the `@wisply`
  scope at another registry is used the same way. With `--prefix /`, npx
  ignored both and went to registry.npmjs.org. So `STANDARD_ENTRY` is
  `{"command": "npx", "args": ["-y", "--prefix", "/", "@wisply/mcp@0.1.0"]}`
  (`NPX_FLAGS`), every command is `NPX_COMMAND` (`npx -y --prefix /
  @wisply/mcp@0.1.0`), and `tests/pack.test.mjs` refuses any other npx form
  in the README, SECURITY.md, the CHANGELOG, this file and
  `lib/messages.mjs`. A global install (`npm i -g @wisply/mcp@0.1.0`) doesn't
  read a project's `.npmrc`, so it needs no flag.
- **The design's links, re-derived.** Every literal snippet, command and
  link in the design that runs `@wisply/mcp@0` becomes the standard entry
  above. Re-derived from `STANDARD_ENTRY` the way the design built them
  (each reproduces the design's link byte for byte when given the design's
  old entry; `tests/pack.test.mjs` re-derives these lines):
  - Cursor: `https://cursor.com/en/install-mcp?name=wisply&config=eyJjb21tYW5kIjoibnB4IiwiYXJncyI6WyIteSIsIi0tcHJlZml4IiwiLyIsIkB3aXNwbHkvbWNwQDAuMS4wIl19`
  - LM Studio: `https://lmstudio.ai/install-mcp?name=wisply&config=eyJjb21tYW5kIjoibnB4IiwiYXJncyI6WyIteSIsIi0tcHJlZml4IiwiLyIsIkB3aXNwbHkvbWNwQDAuMS4wIl19`
  - VS Code: `https://insiders.vscode.dev/redirect?url=vscode%3Amcp%2Finstall%3F%257B%2522name%2522%253A%2522wisply%2522%252C%2522command%2522%253A%2522npx%2522%252C%2522args%2522%253A%255B%2522-y%2522%252C%2522--prefix%2522%252C%2522%252F%2522%252C%2522%2540wisply%252Fmcp%25400.1.0%2522%255D%257D` (Insiders: `vscode-insiders%3A` in place of `vscode%3A`)
  - Kiro: `https://kiro.dev/launch/mcp/add?name=wisply&config=%7B%22command%22%3A%22npx%22%2C%22args%22%3A%5B%22-y%22%2C%22--prefix%22%2C%22%2F%22%2C%22%40wisply%2Fmcp%400.1.0%22%5D%7D`
  - Goose: the query's arguments become `cmd=npx&arg=-y&arg=--prefix&arg=%2F&arg=%40wisply%2Fmcp%400.1.0` (the rest of the query is unchanged)
  - Gemini CLI: `gemini mcp add --scope user wisply npx -- -y --prefix / @wisply/mcp@0.1.0`
  - Claude Code, Codex, Amp, Grok CLI: `... -- npx -y --prefix / @wisply/mcp@0.1.0`; Factory: `droid mcp add wisply "npx -y --prefix / @wisply/mcp@0.1.0"`
- **The setup command is pinned too.** The design's "Errors" texts name the
  setup command with the bare package name (no version, no `--prefix /`),
  which runs npm's newest release in the one command that writes the token
  to the keychain. Once the package name is final, `SETUP_COMMAND` is
  `${NPX_COMMAND} setup` (`npx -y --prefix / @wisply/mcp@0.1.0 setup`); the
  texts are otherwise word for word. Until then it is `wisply-mcp setup`
  (DIST-M2, below).
- **Behavior rule 6, "Any other JSON-RPC error passes through."** The
  connector keeps Wisply's error code but replaces Wisply's message with a
  fixed text (`messages.rpcFailed`), because Wisply's message could one day
  echo arguments (a search query, an API key) into the client's logs.
- **`missing-scope` only for the recording scope.** Rule 6 maps any
  `missing-scope` to `UPDATE_WISPLY_SCOPE`. Every Wisply with the identity
  check knows the full and connector scopes, so a missing proof for either
  is a failed check (`NOT_WISPLY`); only a missing `recording` proof means a
  Wisply that may predate `wspr_` tokens.
- **`UPDATE_WISPLY_SCOPE` covers both causes, and Wisply's own 503 has its
  own text.** A current Wisply leaves out the proof of any token it can't
  read from the Keychain, and answers 503 ("MCP tokens are unavailable.
  Check Keychain access in Wisply.") when it can read none
  (`MCPServer+Identity.swift`, MCP_SETUP.md section 6). The design's texts
  would tell that user to update Wisply, or to quit "whatever is using that
  port". Now `UPDATE_WISPLY_SCOPE` is "This version of Wisply doesn't know
  recording-control tokens (wspr_), or couldn't read yours from the
  Keychain, so the token wasn't sent. Update Wisply, or quit and reopen it
  and copy the recording token again; or use the connector token.", and a
  503 with Wisply's text is the outcome `keychain` with the new text
  `KEYCHAIN_UNAVAILABLE` ("Wisply on 127.0.0.1:{port} couldn't read its MCP
  tokens from the Keychain, so the token wasn't sent. Quit and reopen
  Wisply, and allow Keychain access if macOS asks."). Any listener can send
  that text; it only picks the advice, and the token is kept back either
  way. Any other 503 is still `NOT_WISPLY`. The VS Code extension and the
  wisply.ai troubleshooting section should use the same two texts.
- **`contract/SOURCE.json` shape.** The design lists `{repository, commit,
  provisional, files: {name: sha256}}`. The file is `{schema:
  "wisply-mcp-vendor-v1", provisional, sources: [{repository, commit,
  provisional, files: {<local path>: {upstream, sha256, transcribed_from?}}}]}`:
  one entry per source repository (wisply-ai and wisply-claude-plugin), and
  the upstream path beside the local one because they differ
  (`Docs/mcp-contract.json` lands at `contract/mcp-contract.json`). The
  extension's `vendor/SOURCE.json` should use the same shape.
- **`"private": true` in `package.json`.** Not in the design's package.json
  row. It is true exactly while the contract is provisional
  (`tests/pack.test.mjs`), so `npm publish` refuses the package without
  running any script; removing it is the explicit release step.
- **`lib/contract-shape.mjs`.** Not in the design's tree. The shape check
  (`contractProblems`) moved out of `lib/contract.mjs`, which throws at
  import on a broken vendored contract, so `scripts/sync-vendor.mjs` can
  check wisply-ai's file before it writes anything, even in a tree whose
  vendored copy is broken. `lib/contract.mjs` re-exports it. A vendored copy
  of `lib/contract.mjs` (the VS Code extension) needs this file too.
- **`sync-vendor` refuses before it writes.** It reads every upstream file
  at its commit, refuses a missing file or a contract the connector can't
  load (the shape check, so `tool_descriptors` and the three scopes are
  required without `--provisional`), and only then writes the files,
  `SOURCE.json` and the generated module (`tests/sync-vendor.test.mjs`).
- **The transcription check reads the commit it names.** The provisional
  fixture is checked word for word against `MCPToolCatalog.swift` (and the
  scope, port and scheme sources) at the commit `SOURCE.json` records
  (885cc75), not the checkout, and a separate test fails with "changed since
  885cc75: update the provisional fixture ... or re-vendor" when the
  checkout's sources have moved on (raycast PR 1's `tail_words`).
- **Release checks the design doesn't list.** `WISPLY_RELEASE=1 npm test`
  also fails until `docs/release-checks.json` records (1) `port_exclusive`
  for the Wisply commit the contract is vendored from (Wisply sets
  `allowLocalEndpointReuse = true`, so the identity check's assumption that
  Wisply holds its port alone must be shown on a Mac, or the app must bind
  exclusively), and (2) `registry_namespace`, the MCP Registry verification
  of `MCP_NAME` (`ai.wisply/local` needs DNS or HTTP proof on wisply.ai;
  the fallback is `io.github.fal3/wisply-mcp`), and while the vendored
  contract marks `setup_claude` `destructiveHint: false` (it replaces the
  Anthropic key stored in Wisply; the fix belongs in wisply-ai's
  `MCPToolCatalog.swift`, and `stop_recording` may deserve the same).
  `MCP_NAME` in `lib/constants.mjs` is a placeholder like `PACKAGE_NAME`.

## setup, status and forget (DIST-M2)

- **No package name before it is Wisply's.** `PACKAGE_NAME_FINAL` in
  `lib/constants.mjs` (false; `tests/pack.test.mjs` ties it to
  `!package.json "private"`) gates every command the connector names. While
  it is false, `SETUP`, `MALFORMED` and `NOT_WISPLY` in tool results (which
  the model also reads) use the interim wording that names only
  `WISPLY_MCP_TOKEN`, and terminal texts (setup, status, forget, argument
  errors) name the bin: `wisply-mcp setup`, `wisply-mcp status`,
  `wisply-mcp forget` (`COMMAND_PREFIX`). Once it is true they become
  `NPX_COMMAND` commands, as above. Nobody, person or agent, is told to `npx`
  an npm name someone else could still register.
- **`SETUP_MALFORMED`.** When setup's read-back isn't a Wisply token it prints
  `SETUP_MALFORMED`, not the design's `MALFORMED` (which says
  "WISPLY_MCP_TOKEN is set", wrong in setup): "That isn't a Wisply token (it
  should start with wspc_, wspr_ or wsp_ and have 64 hex characters), so it
  wasn't saved. Copy the read-only connector token from Wisply > Settings >
  Integrations > MCP Server and run `{setup command}` again." The VS Code
  extension and the wisply.ai page should use the same text.
- **Setup replaces instead of updating.** The design's `WRITE_ARGS` use
  `add-generic-password -U`. On an existing item, `-U` keeps that item's
  access list and only merges `-T` into it (Apple's `keychain_add.c` /
  `access_utils.c`), so an item made earlier by another tool could keep
  trusting other programs. Setup deletes every earlier item first
  (`deleteAllKeychain`; `REPLACE_FAILED` stops it before `security` asks if
  that fails) and adds without `-U`, so the item's access list is always the
  documented one. Cancelling after that leaves no item, and setup says so
  (`SETUP_CANCELLED_AFTER_REMOVAL`, `PREVIOUS_REMOVED`); `SETUP_CANCELLED`
  ("Your login keychain wasn't changed") is printed only when there was
  nothing to remove.
- **`forget` removes every copy.** The design's `deleteKeychain` runs
  `delete-generic-password` once, which removes only the first match in the
  keychain search list. `forget` repeats it until `security` finds none (at
  most `KEYCHAIN_MAX_COPIES`, plus one run that has to find none) and
  reports the count. It also ignores `WISPLY_MCP_PORT`, so a stale value
  can't block it.
- **`security` gets a filtered environment.** Reads, writes and deletes run
  `/usr/bin/security` with this process's environment minus every
  `WISPLY_MCP_*` variable (`securityEnv`), so an env token never reaches the
  child.
- **Tokens as arguments.** An argument or `WISPLY_MCP_PORT` that looks like a
  token (a prefix with hex, or 16+ hex characters) gets the fixed
  `TOKEN_AS_ARGUMENT` text and is never echoed, not even in part, because AI
  apps keep the connector's stderr in their log files.
- **Full-access note.** `setup --full-access` (`FULL_ACCESS_SHARED`) and
  `status` with a full-access keychain item say that every AI app without its
  own token gets full access.
- **`forget` off macOS.** The design leaves it open. `forget` prints its own
  text (`nothingSavedOffMac`: "This connector saves a token only in the macOS
  Keychain, and this computer runs {platform}, so there's nothing to
  remove.") and exits 0, instead of `NOT_MAC` and exit 1: setup refuses off
  macOS, so no saved copy can exist. `setup` and `status` keep `NOT_MAC` and
  exit 1 there, as the design says for status.
- **Exit codes.** The design gives status "0 OK, 1 problem". All three
  commands use 0 done, 1 a problem the message names, and 2 a usage mistake
  (an unknown option, a bad port, a token passed as an argument).
- **The `keychain` and `missing-scope` outcomes in setup and status.** Setup
  and status print the same texts as tool results for the bridge's
  `keychain` outcome (`KEYCHAIN_UNAVAILABLE`) and for `missing-scope`
  (`UPDATE_WISPLY_SCOPE`, both causes). Status's one-line summaries are
  "answered on 127.0.0.1:{port}, but couldn't read its MCP tokens from the
  Keychain" and "answered on 127.0.0.1:{port}, but sent no proof for
  recording-control tokens".

## print-config and install (DIST-M4)

- **The argument list carries npx's flags.** The design's templates
  (`clients/mcp-clients.json`, "Client templates") render `{{args_list}}`
  and `{{args_cli}}` from `["-y", spec]`. Here they render the bridge's
  arguments from `bridgeArgs()`: `NPX_FLAGS` and the exact version
  (`-y --prefix / @wisply/mcp@0.1.0`), plus `--port <n>` only for another
  port. So `package_spec` is `@wisply/mcp@0.1.0`, `standard_entry` equals the
  bridge's `STANDARD_ENTRY` (`tests/clients.test.mjs`), and command
  templates read `... -- npx {{args_cli}}`. An argument may hold only
  `A-Z a-z 0-9 @ . _ / -`, so neither placeholder needs escaping in JSON,
  JSONC, TOML, a YAML flow sequence or a shell command. wisply-ai's
  `MCPClientSnippets` and wisply-web's renderer build the same list.
- **`"published"`.** Not in the design's file shape. It is `false` until the
  npm name is Wisply's, equal to `!package.json "private"`
  (`tests/clients.test.mjs`), and `WISPLY_RELEASE=1 npm test` requires
  `true`. Consumers render nothing while it is `false`, so no public page or
  app copy sends anyone to an npm name someone else could still register.
  The first publish flips it with `"private"`, `PACKAGE_NAME_FINAL` and the
  provisional contract.
- **More fields per app.** Each entry may also have `note` (one sentence
  shown under the snippet), `install` (`{"type": "command", "command"}`,
  `{"type": "add-mcp", "program", "hint"}` or `{"type": "json-file", "path",
  "key", "target"?, "path_env"?, "dir_env"?, "hint"?}`), and alternatives
  carry their own `format`. Consumers that don't use them ignore them.
- **Destinations that differ from the design's table.** Kiro is the user
  file `~/.kiro/settings/mcp.json` (the design names the workspace file);
  the Cline entry names the extension's own list (MCP Servers > Configure >
  Configure MCP Servers) and the CLI's
  `~/.cline/data/settings/cline_mcp_settings.json`.
- **`print-config` with no app lists the apps.** The design has
  `print-config <client>` only. With no app it prints the list (apps that
  `install` handles are marked) and exits 0; an unknown app exits 2 with the
  list. The snippet alone goes to stdout, so `print-config cursor | pbcopy`
  copies only it; where it goes, the note and the docs link go to stderr. An
  alternative's id (`vscode-inputs`) works as an app.
- **`install` is macOS only.** Elsewhere it prints `NOT_MAC` and exits 1,
  as setup does.
- **How `install` runs an app's command.** The design says `execFile` with a
  fixed argv. Here the program (`claude`, `codex`, `gemini`, `code`) is also
  looked up in PATH's absolute folders only and run by that absolute path
  (shown in the "Running:" line): a relative PATH entry such as `.` would
  find a program planted in the folder install runs in. The child's
  environment is this one minus `WISPLY_MCP_TOKEN`, minus any variable
  holding something token-shaped, with PATH reduced to its absolute folders;
  it runs without a shell, for at most 60 seconds. `code --add-mcp` gets
  `{"name": "wisply", "type": "stdio", "command": "npx", "args": [...]}`.
- **Zed's settings are never edited.** The design lists
  `context_servers.wisply` among the file installs. Zed's `settings.json` is
  JSONC and usually has comments, which the design's own rule ("refuses to
  touch invalid JSON") would refuse anyway, so `install zed` prints the
  snippet (exit 1), as for every app without an install.
- **Which Cline file.** `install cline` writes the Cline CLI's
  `~/.cline/data/settings/cline_mcp_settings.json` (or
  `CLINE_MCP_SETTINGS_PATH`), says "Cline CLI", and prints where the
  extension keeps its own list. GitHub Copilot CLI's file follows
  `COPILOT_HOME`.
- **The file change is a splice.** The design says "sets only
  `mcpServers.wisply` ... and writes atomically". Here install changes the
  text of that one entry (or appends it, laid out like its neighbours) and
  keeps every other byte (layout, escapes, number spellings, other servers),
  then parses the result and requires it to be exactly that change. It
  refuses comments, repeated keys and text that isn't UTF-8 (`not-plain`),
  needs the file's folder to exist (it never creates an app's settings
  folder), follows a symlink and keeps it, re-reads the file just before the
  rename and gives up ("changed", quit the app) if the app wrote it
  meanwhile, and undoes a failed write.
- **The backup never holds a token.** The design's `<file>.wisply-backup`
  is a copy of the original. A copy would put a plaintext token from an old
  hand-pasted `wisply` entry into a new file. So install writes the backup
  itself, once, with `O_EXCL` and mode 0600, every Wisply token masked as
  `wsp...`, and says when the entry it replaced held a token in plain text
  (regenerate it in Wisply).
- **install never reads a token.** Not the environment's, not the
  Keychain's: the entry it installs reads the Keychain item at run time.
  `tests/clients.test.mjs` runs install with a token in the environment and
  in a stub Keychain and checks every argv, child environment and written
  file.
- **The commands' own names follow DIST-M2's rule.** `print-config` and
  `install` texts name `wisply-mcp print-config` / `wisply-mcp install`
  until `PACKAGE_NAME_FINAL`, then `npx -y --prefix / @wisply/mcp@0.1.0 ...`
  (`PRINT_CONFIG_COMMAND`, `INSTALL_COMMAND` from `COMMAND_PREFIX`). The
  snippets themselves always show the npx entry, because they are what the
  app runs, and their consumers wait for `"published"`.
