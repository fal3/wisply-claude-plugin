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

## Plugins, extensions and the bundle (DIST-M3)

- **The standard entry reaches every surface here.** The design's
  `server.json` variable description, the Gemini extension's and the
  bundle's token fields and `llms-install.md` name the setup command with the
  bare package name (no version, no `--prefix /`), and its README matrix and
  deeplinks use the old `["-y", "@wisply/mcp@0"]` entry. Here every npm snippet,
  link and command in them is the standard entry above, and the setup command
  they name is the final one, `NPX_COMMAND` plus `setup`
  (`npx -y --prefix / @wisply/mcp@0.1.0 setup`), not the interim
  `wisply-mcp setup` that `PACKAGE_NAME_FINAL` gives the connector's own
  texts: these files are read only once this repository or its release is
  public, which waits for the npm organization (SECURITY.md, release control
  1). `tests/manifests.test.mjs` and `tests/registry.test.mjs` build what
  they expect from `STANDARD_ENTRY`, `NPX_FLAGS` and `NPX_COMMAND`, so these
  move with the constants. The Agent Plugin, the Gemini extension and the
  bundle run their own copy with `node`, never `npx`, so their server entries
  are unchanged.
- **The skill keeps the design's text.** `skills/wisply-memos/SKILL.md` is
  the design's exact text. Its `compatibility` line names the connector by
  its bare package name, as a description rather than a command to run, and
  has no version, so the skill doesn't change with every release. The VS
  Code extension (DIST-V2) and wisply.ai (DIST-W1) vendor it byte for byte;
  if the spec wants the standard entry there too, it changes in all three at
  once.
- **`server.json` follows `MCP_NAME`.** Its `name` must equal
  `package.json` `"mcpName"` (the registry ties the two), so it is the same
  placeholder: if wisply.ai can't be verified, all three become
  `io.github.fal3/wisply-mcp` together (`tests/registry.test.mjs`).
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
- **No `setup_claude` in the bundle's tools.** The bundle never passes
  `--allow-claude-setup`, so its manifest (which Claude's directory and
  Smithery read) lists the eight tools it can serve.
- **Token fields say what a full-access token allows.** The connector accepts
  any Wisply token from `WISPLY_MCP_TOKEN`, so the bundle's and the Gemini
  extension's token fields recommend `wspc_` and say that a `wsp_` token lets
  the AI app start and stop recordings and propose follow-ups.
- **The icon sits next to the manifest.** The design's tree has `icon.png`
  at the repository root. It is `mcpb/icon.png`, because the manifest's
  `icon` is relative to the manifest, so
  `mcpb validate mcpb/manifest.json` passes and `build-mcpb.mjs` stages the
  same file.
- **Two release assets.** Every release carries the bundle and
  `SHA256SUMS`, and the notes repeat its line. Gemini CLI installs a GitHub
  repository from its newest release: with exactly one asset whose name has
  no platform in it, it takes that asset for the extension and fails to
  unpack a `.mcpb`; with two, it uses the tag's source archive.
- **Release build.** The design packs with `npx -y @anthropic-ai/mcpb@2.1.2`
  and has the CI job `mcpb` run
  `npm install --no-save --ignore-scripts --prefix .ci/mcpb @anthropic-ai/mcpb@2.1.2`.
  The release build and CI use the copy installed from `tools/mcpb`'s
  committed lockfile instead (`npm ci --ignore-scripts --prefix tools/mcpb`,
  integrity hashes for every dependency), refuse a checkout that isn't clean
  or isn't at the tag, and stage the tag's own files. The gate runs on the
  asset downloaded back from the draft release and compares its contents with
  the tag, not only its sha256.
- **Git installs and `main`.** Git-sourced installs (Agent Plugin, Gemini
  extension) follow the default branch unless they name a ref, so the README
  gives `--ref v<version>` where the app takes one (Codex, Gemini CLI;
  GitHub Copilot CLI's `plugin install` and VS Code's **Install Plugin From
  Source** take none), and the release controls add a `main` ruleset (pull
  requests with CI only, no force-push or deletion, signed commits) to the
  design's `v*` tag ruleset and immutable releases.
