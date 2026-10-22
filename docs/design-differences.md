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
  row. It is true exactly while the contract is provisional or the package
  name isn't final (`tests/pack.test.mjs`), so `npm publish` refuses the
  package without running any script; removing it is the explicit release
  step once both hold.
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
  exclusively), (2) `registry_namespace`, the MCP Registry verification
  of `MCP_NAME` (`ai.wisply/local` needs DNS or HTTP proof on wisply.ai;
  the fallback is `io.github.fal3/wisply-mcp`), and (3) `npm_scope`, that
  the npm organization `@wisply` (or, for the fallback name, `wisply-mcp`)
  is Wisply's with two-factor authentication required and `wisply-mcp` held
  too (Grok packet G-NPM), with `PACKAGE_NAME_FINAL` true and `"private"`
  gone from `package.json`; and while the vendored
  contract marks `setup_claude` `destructiveHint: false` (it replaces the
  Anthropic key stored in Wisply; the fix belongs in wisply-ai's
  `MCPToolCatalog.swift`, and `stop_recording` may deserve the same).
  `MCP_NAME` in `lib/constants.mjs` is a placeholder like `PACKAGE_NAME`.

## setup, status and forget (DIST-M2)

- **No package name before it is Wisply's.** `PACKAGE_NAME_FINAL` in
  `lib/constants.mjs` (false) gates every command the connector names.
  `tests/pack.test.mjs` ties it to `npm_scope.verified` in
  `docs/release-checks.json`, which Alex sets once the npm organization is
  his, not to the contract or to `"private"`: re-vendoring the contract
  (DIST-M5) must not make tool texts name an npm package nobody owns yet. The
  README's status note tells readers not to run its `npx` commands before the
  first release while the name isn't final (`tests/pack.test.mjs`), and
  SECURITY.md's release control 1 counts this repository going public, or
  its README going to a catalog, as naming the package. While
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
- **Full-access and recording notes.** `setup --full-access`
  (`FULL_ACCESS_SHARED`) and `status` with a full-access keychain item say
  that every AI app without its own token gets full access. A recording-control
  token in the keychain reaches the same apps, so `setup` with one
  (`RECORDING_SHARED`) and `status` with one (`STATUS.recordingShared`) say
  that every such app can start and stop recordings while Wisply allows
  agents to, and propose follow-ups. Unlike `wsp_`, a `wspr_` token needs no
  flag: the design's D5 gates only `wsp_`, the token is labelled as recording
  control in Wisply, and start and stop also need Wisply's own switch. Whether
  `setup` should also require a `--recording` flag is left to the spec (the
  VS Code extension's "Store Token in the Mac Keychain" runs `setup` without
  flags, so it would need the same change).
- **`print-config` and `install` in this build.** They answer
  `notInThisBuild`: "wisply-mcp: "{command}" isn't in this build yet. Add the
  standard entry from the guide (https://www.wisply.ai/docs/mcp/install) to
  your AI app, then run `{setup command}` once (wisply-mcp --help)." (exit
  1), not the earlier advice to set `WISPLY_MCP_TOKEN` in the app's settings,
  which steered people to put a token in a config file. DIST-M4 replaces both
  commands.
- **Manual QA 2's impostor (for DIST-A2's `Docs/NEXT_CUT_QA.md`).** The
  design runs a bare `nc -l 51771` and expects `NOT_WISPLY`. `nc -l` accepts
  the connection and never answers, so the identity check runs out its 3 s
  and the outcome is `unavailable` ("Wisply: not answering on
  127.0.0.1:51771", `UNAVAILABLE`): a listener that stays silent can't be
  told apart from a Wisply that hangs, and the token is kept back either way,
  so the connector keeps that mapping. The QA step uses an impostor that
  answers instead: `printf 'HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\n{}' | nc -l 51771`
  or `echo garbage | nc -l 51771` both give `NOT_WISPLY` with a connector or
  a recording token (reproduced against `status` with OpenBSD netcat), and
  the request `nc` prints has no `Authorization` header. SECURITY.md's manual
  QA list has the step.
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
