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
  provisional, on_main?, files: {<local path>: {upstream, sha256, transcribed_from?}}}]}`:
  one entry per source repository (wisply-ai and wisply-claude-plugin), and
  the upstream path beside the local one because they differ
  (`Docs/mcp-contract.json` lands at `contract/mcp-contract.json`). DIST-M5
  added `on_main` to wisply-ai's entry once it is vendored from a real
  commit (see its section). The extension's `vendor/SOURCE.json` should use
  the same shape.
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
- **Drift fails on `main`, and is listed on an unmerged branch.** The
  fixture follows wisply-ai's `main`. When `WISPLY_AI_DIR` is a branch
  `origin/main` doesn't have (a lane's worktree, such as raycast PR 1's or
  DIST-A1's), the contract and catalog checks compare the commit where it
  left `main` too: drift found only on the branch is listed and the test is
  skipped, since it reaches the fixture through the re-vendor once it is
  merged; drift `main` already has fails. A wisply-ai contract with
  `tool_descriptors` but without raycast PR 1's keys (DIST-A1 alone), which
  `sync-vendor` refuses, is compared key by key (scope by scope, descriptor
  by descriptor); one the connector can load asks for the re-vendor.
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
- **The registry entry carries npx's flags.** The design's `server.json`
  npm package has no `runtimeArguments`. Apps that install from the MCP
  Registry build the command from the entry themselves: VS Code's gallery
  (`mcpManagementService.ts`, `getMcpServerConfigurationFromManifest`) runs
  `npx`, then `runtimeArguments`, then `identifier@version`, then
  `packageArguments`, and adds no `-y` and no `--prefix` for npm, so the
  design's entry would run the package through npx with no flags at all, in
  the open project: the form DIST-M1 closed everywhere else. Here the package has
  `"runtimeArguments": [{"type": "positional", "value": "-y"},
  {"type": "named", "name": "--prefix", "value": "/"}]` (a positional
  argument adds its value, a named one its name and then its value), so a
  registry install runs the standard entry. The registry checks only named
  arguments (no `<`, `>`, space or `$` in the name; the value doesn't start
  with the name), which these pass. `tests/registry.test.mjs` builds the
  command as VS Code does and requires `STANDARD_ENTRY`, so the entry moves
  with `NPX_FLAGS`.
- **The skill names the package, not a command.** The design's
  `compatibility` line names the connector as an npx command: `-y` and the
  bare package name, with no `--prefix /` and no version. A model reads the
  skill and may run or relay that as the way to install, and it is the form
  DIST-M1 found can run a copy planted in the open project with
  `WISPLY_MCP_TOKEN`. Here it reads
  "Needs the Wisply MCP connector (the @wisply/mcp package, or the Wisply
  plugin or extension for this app) on the Mac that runs Wisply, with
  Wisply's MCP server turned on." The rest of the skill is the design's exact
  text. It still has no version, so it doesn't change with every release.
  `tests/skills.test.mjs` refuses any `npx` or `npm install` in the skill,
  the Gemini commands and the Cursor extras, and
  `tests/manifests.test.mjs` sweeps every file in `skills/`, `commands/` and
  `extras/` for an npx of the package without the standard flags. The VS
  Code extension (DIST-V2) and wisply.ai (DIST-W1) vendor the skill byte for
  byte, so they take this text when they re-vendor it, and the spec's skill
  block changes to match.
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
  unconditional. (Done: the re-vendored contract has `tail_words`, and
  `live.toml` asks for 400 words, as the design says.)
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
  the tag, not only its sha256. The design's `WISPLY_REGISTRY_RELEASE=1`
  refuses only the all-zero placeholder; here it also fails without
  `WISPLY_MCPB_FILE`, because from the second release on `server.json`
  holds the previous release's real hash, which only the new asset can tell
  from the right one (the registry only sends a HEAD request to the URL), and
  release control 7 resets `fileSha256` to the placeholder with each version
  bump. The build stages regular files only: `trackedSource` refuses a
  tracked symlink or a path under a symlinked folder, `refSource` accepts
  only git modes 100644 and 100755 (never 120000 or 160000) for the code, the
  manifest and the icon, the manifest's `icon` must be `icon.png`, and
  `stageBundle` refuses any path that would land outside the stage.
- **Git installs and `main`.** Git-sourced installs (Agent Plugin, Gemini
  extension) follow the default branch unless they name a ref, so the README
  gives `--ref v<version>` where the app takes one (Codex, Gemini CLI;
  GitHub Copilot CLI's `plugin install` and VS Code's **Install Plugin From
  Source** take none), and the release controls add a `main` ruleset (pull
  requests with CI only, no force-push or deletion, signed commits) to the
  design's `v*` tag ruleset and immutable releases.

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
- **Nothing renders a setup before the release, the connector included.**
  The design has `print-config` and `install` print and write the npx entry.
  Until `SETUPS_RELEASED` (`PACKAGE_NAME_FINAL` and `"published"`),
  `render()` and `installPlan()` throw `NotReleasedError` for every bundler
  of `lib/clients.mjs` (the bin, the VS Code extension's server), and
  `print-config <app>` and `install <app>` print `SETUPS_NOT_RELEASED` and
  exit 1 without writing a file or running an app's command; `print-config`
  with no app still lists the apps, with a "Not yet" line. An entry written
  before the release would run `npx -y` of an unowned name every time the
  app starts. Tests preview the setups with `beforeRelease: true` and run the
  CLI with `released: true`.
- **More fields per app.** Each entry may also have `note` (one sentence
  shown under the snippet), `install` (`{"type": "command", "command"}`,
  `{"type": "add-mcp", "program", "hint"}` or `{"type": "json-file", "path",
  "key", "target"?, "path_env"?, "dir_env"?, "hint"?}`), and alternatives
  carry their own `format`. `path_env` names a variable that holds the file;
  `dir_env` is an ordered list of `{"name", "path"}`, a variable that holds a
  folder and the file's place in it. Consumers that don't use them ignore
  them.
- **Destinations that differ from the design's table.** Kiro is the user
  file `~/.kiro/settings/mcp.json` (the design names the workspace file);
  the Cline entry names `~/.cline/data/settings/cline_mcp_settings.json`,
  which Cline 4.0 and later share between the extension, the CLI and the
  JetBrains plugin.
- **wisply-ai's copy is pinned, not mirrored.** wisply-ai pins
  `Docs/mcp-clients.json` to a commit of `clients/mcp-clients.json`
  (`MCPClientSnippetsTests.vendoredClients`), so the upstream test accepts
  the file as of any commit here while the copy says `"published": false`
  (Wisply renders nothing from it), reports it as a TODO, and fails for a
  copy no commit here has, or a published copy that isn't the current file.
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
- **Which Cline file.** Since Cline 4.0.0 ("Migrate legacy MCP files and
  formats into the shared settings file"), the extension, the CLI and the
  JetBrains plugin read one file, so `install cline` writes it and says
  "Cline". It finds the file as Cline's `getSharedMcpSettingsPath` does
  (cline/cline `apps/vscode/src/hosts/vscode/mcp-settings-legacy-migration.ts`,
  checked on 2026-10-22): `CLINE_MCP_SETTINGS_PATH`, else `CLINE_DATA_DIR` +
  `settings/cline_mcp_settings.json`, else `CLINE_DIR` (default `~/.cline`) +
  `data/settings/cline_mcp_settings.json`. GitHub Copilot CLI's file follows
  `COPILOT_HOME`. The first variable that is set decides; one that isn't a
  full path (Cline doesn't expand `~` either) makes install change nothing
  and print the snippet (exit 1), because the app would resolve it against
  its own working folder. When a variable decides, install says so.
- **`--port` only.** The design gives print-config and install the bridge's
  options. Here they ignore `WISPLY_MCP_PORT` (with a note on stderr for
  print-config, stdout for install, that never echoes the value), so a port
  exported for a test Wisply doesn't end up in an app's settings unasked.
  setup and status still read it, as serving does; forget takes no port.
- **Re-running install.** For a JSON file, an entry that already matches (in
  any key order) is "unchanged", exit 0. `claude mcp add` refuses a name it
  already has, and install can't tell whether that entry is this one, so a
  second `install claude-code` exits 1 with `commandEntryExists` (run
  `claude mcp remove wisply`, then install again). `codex mcp add` and
  `gemini mcp add` replace the entry.
- **What install keeps of an old entry.** The design replaces
  `mcpServers.wisply` whole. Here the old entry's `KEPT_FIELDS`
  (`autoApprove`, `alwaysAllow`, `disabled`, `disabledTools`, `timeout`,
  `tools`) stay unless one holds something token-shaped, so a second install
  doesn't reset Cline's approvals or Copilot CLI's narrowed tools; every other
  old field goes, and install names those (`Not carried over from the old
  entry: env.`).
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
  (regenerate it in Wisply). Other servers' secrets stay in it, as in the
  file, and install says so and to delete the backup once the app works; no
  command removes it. The temporary file is written with mode 0600 and gets
  the file's own mode just before the rename. A file with a second hard link
  is refused (`hard-linked`): the rename would leave the other link with the
  old text.
- **Where the data goes.** print-config's hint and install's last lines say
  that what the app reads from Wisply, transcripts included, goes to the AI
  service it uses (`appDataNote`), as the README and SECURITY.md do.
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
  app runs, and nothing renders them before the release: their consumers
  wait for `"published"`, and the connector's own `render()` and
  `installPlan()` for `SETUPS_RELEASED`. No template names a command: the
  `vscode-inputs` prompt, which VS Code shows when it asks for the token,
  says only "the token that the connector's setup saved in your login
  keychain".
## Release workflow and the re-vendor (DIST-M5)

- **Re-vendored before DIST-A1's merge, from its commit.** The design has
  DIST-M5 re-vendor "from DIST-A1's merge commit" once DIST-A1 is merged.
  DIST-A1 isn't on wisply-ai's `main` yet, but its branch
  (`claude/distribution-1` at 5e4d308) now has raycast PR 1 merged in, so its
  `Docs/mcp-contract.json` is the union the connector needs (the `wspr_`
  scope, error codes, `live_transcript`, `tail_words`, `tool_descriptors`,
  and two keys DIST-A1 added later: per-tool `destructiveHint`, true for
  `setup_claude`, and `distribution` with `exclude_tools: ["setup_claude"]`
  and `setup_claude_token_free: true`). This branch vendors that file with
  `npm run sync-vendor`, byte for byte, with `"provisional": false` as the
  design says. So that "not provisional" can't be read as "from `main`",
  `contract/SOURCE.json` records a fact the design doesn't have,
  `"on_main"`: whether the wisply-ai checkout's `origin/main` had the commit
  when it was vendored (false here). `WISPLY_RELEASE=1 npm test` refuses
  `"on_main": false` (`tests/vendor.test.mjs`), `"private"` stays while it is
  false (`tests/pack.test.mjs`), and the release gate refuses a CHANGELOG
  release section that still mentions it. Once DIST-A1 merges, running
  `npm run sync-vendor` again from the main commit is the whole follow-up
  (SECURITY.md, "Re-vendoring the contract"); if review changes the file, the
  upstream test against wisply-ai's `main` reports the difference.
- **What the re-vendor changed.** `commands/wisply/live.toml` asks for
  `tail_words` 400 without the hedge, and `PENDING_ARGUMENTS` in
  `tests/skills.test.mjs` is empty. `tests/contract.test.mjs` expects
  `destructiveHint` only on `setup_claude` and checks that the contract's
  `distribution.exclude_tools` is what the connector hides without
  `--allow-claude-setup` (the connector doesn't read the key; a newly
  excluded tool fails the test until it does). The bundle's tool list
  (`mcpb/manifest.json`) didn't change: `setup_claude` was already left
  out, and the other descriptions are the same. The bridge still passes
  `setup_claude` results on unchanged; DIST-A1's docs ask clients to drop
  `cursor_mcp_json` for older Wisply builds, which is left for a connector
  PR (the switch stays off by default).
- **Drift fails on `main`, and is listed on an unmerged branch.** With a
  vendored (not provisional) contract, `tests/upstream.test.mjs` checks that
  the file is wisply-ai's at the recorded commit, that the checkout's file
  is the same, and that `"on_main"` matches the checkout's `origin/main` (a
  TODO while the commit isn't there yet, or once it is and SOURCE.json still
  says false). When `WISPLY_AI_DIR` is a branch `origin/main` doesn't have (a
  lane's worktree, such as raycast PR 1's), a difference found only on the
  branch is listed and the test is skipped (DIST-M4's 4727f5a logic); one
  `main` already has fails. The provisional-only checks (the descriptors
  against the Swift catalog at the transcription commit, 885cc75, and a
  wisply-ai contract with `tool_descriptors` but without raycast PR 1's keys
  compared key by key) stay for a provisional fixture and skip otherwise.
- **wisply-ai's copy is pinned, not mirrored.** wisply-ai pins
  `Docs/mcp-clients.json` to a commit of `clients/mcp-clients.json`
  (`MCPClientSnippetsTests.vendoredClients`), so the upstream test accepts
  the file as of any commit here while the copy says `"published": false`
  (Wisply renders nothing from it), reports it as a TODO, and fails for a
  copy no commit here has, or a published copy that isn't the current file.
- **Staged publishing.** The design's last step is `npm publish --provenance
  --access public`. npm's trusted publishing now has "allowed actions", and a
  trusted publisher created after 2026-09-03 allows only `npm stage publish`
  unless the maintainer also allows `npm publish` (npm/documentation
  `trusted-publishers.mdx` and `staged-publishing.mdx` @7e98ab4). The
  workflow therefore runs `npm stage publish --provenance --access public
  --ignore-scripts` (staged publishing needs npm 11.15.0; the pinned 11.21.0
  has it, and `npm stage publish` is `npm publish` with the stage flag, so it
  takes the same options and attaches the same provenance). A staged version
  goes live only when a maintainer approves it with two-factor
  authentication (`npm stage approve <id>`, or npmjs.com > Staged Packages):
  a second human gate after the `release` environment, which npm recommends
  together with "disallow tokens". Re-checked on 2026-10-22 in a clone of
  npm/documentation at 7e98ab4 (`trusted-publishers.mdx`: "Configurations
  created after Sep 03, 2026 are automatically set to allow `npm stage
  publish`"; the GitHub fields are owner, repository, workflow filename,
  optional environment and allowed actions, with no ref). So the design's
  Alex action 4 ("step 4 is the release workflow run that Alex approves")
  needs one more step for every later release: approve the environment's
  run, then `npm stage approve <id>`, and only then the draft release, the
  bundle, the `fileSha256` PR and `mcp-publisher publish` (steps 6 to 10;
  `mcp-publisher` reads `mcpName` from the live npm version, and a rejected
  stage must never get a bundle or a registry entry). SECURITY.md item 6
  and the README say so.
- **More hardening than the design's YAML.** `package-manager-cache: false`
  on setup-node (npm's and setup-node's advice for release builds),
  `timeout-minutes`, `--ignore-scripts` on the publish, and comments. The
  publish job's `if` and permissions are the design's.
- **Two jobs, and only a tag on `main` (DIST-M5 review).** The design has
  one job that runs the checks and the publish with `id-token: write`, so
  every test, git command and `npm pack` could request the publish-capable
  OIDC token. Here a `verify` job with `contents: read` alone checks out the
  whole history (`fetch-depth: 0`), refuses a tagged commit that isn't on
  `main` (`git merge-base --is-ancestor HEAD refs/remotes/origin/main`), and
  runs `npm run check` and `WISPLY_RELEASE=1 npm test`. `publish` has
  `needs: verify`, the `release` environment and `id-token: write`, and runs
  only checkout, setup-node, the npm install and `npm stage publish`. Both
  jobs keep the design's `if`. The ci run itself can't be seen from the
  workflow, so SECURITY.md item 2 says release tags are made only on `main`
  commits whose ci is green.
- **The `release` environment, set up before the first tag, with more rules
  than a reviewer.** The design's Alex action 1 creates it with Alex as the
  required reviewer. SECURITY.md item 2 now also sets "Deployment branches
  and tags" to one tag rule, `v*`, turns off the administrator bypass, and
  gives the `gh api` checks; item 6 starts by checking them. GitHub creates
  a missing environment, unprotected, on the first run that names it, and
  npm's trusted publisher doesn't bind to a ref, so without the tag rule a
  writer's branch with an edited `release.yml` could ask for the OIDC token,
  held back only by the reviewer. "Prevent self-review" stays off while Alex
  is the only maintainer.
- **The maintainer's release check reads real checkouts (DIST-M5 review).**
  `"on_main"` and the sha256 values are the tree's claims about itself, and
  `tests/upstream.test.mjs` used to skip without `WISPLY_AI_DIR`, so a
  hand-flipped `"on_main": true` passed `WISPLY_RELEASE=1 npm test`. Now,
  with `WISPLY_RELEASE=1` outside GitHub Actions, a missing `WISPLY_AI_DIR`
  or `WISPLY_PLUGIN_DIR` fails; each checkout's `origin` must be
  `github.com/fal3/<repository>` (HTTPS or SSH), it must have an
  `origin/main`, and that must have the recorded commit (`"on_main": true`
  checked; the plugin commit, which records no `"on_main"`, too). The bytes
  are the existing upstream tests, which run whenever the variables are set.
  `npm run sync-vendor` also writes `"on_main": true` only for a checkout
  whose `origin` is wisply-ai and says why otherwise. The release workflow
  can't check out the private wisply-ai, so there `"on_main"` is the
  reviewed tree's claim; the workflow, SECURITY.md and the README say so and
  ask for the maintainer's run on the commit before it is tagged. A local
  `git update-ref` can still forge `origin/main`; `git fetch origin main`
  before the run is the advice, not a check.
- **A clean checkout for every release.** The design's Alex action 4 has
  "a clean clone" in prose only. With `WISPLY_RELEASE=1`,
  `tests/pack.test.mjs` now refuses a checkout with changes or untracked
  files (`git status --porcelain --untracked-files=all`) and a tarball that
  isn't exactly `git ls-files` under package.json `"files"` plus
  `package.json`, so a scratch file can't ship in the hand-made 0.1.0, the
  one version with no provenance and no staged review. SECURITY.md item 5
  spells out the procedure: a fresh clone of the tag, the release check with
  both checkouts, `npm pack --dry-run --json`, then
  `npm publish --access public --ignore-scripts`.
- **Dependabot for the packer.** The design pins the MCPB packer but leaves
  it out of Dependabot. `.github/dependabot.yml` now has an `npm` entry for
  `/tools/mcpb` with `open-pull-requests-limit: 0`: security updates only,
  so the deliberate pin moves only in a reviewed change. Security updates
  need Dependabot alerts and security updates turned on in the repository's
  settings; SECURITY.md item 8 adds `npm audit --prefix tools/mcpb` before
  each bundle build.
- **DIST-M5 stays open until the re-vendor from `main`.** The design's
  done-criterion is a contract re-vendored "from DIST-A1's merge commit".
  This branch vendors DIST-A1's unmerged branch commit 5e4d308
  (`"on_main": false`, refused by the release gate), and on 2026-10-22
  wisply-ai's `main` is still 1a1f655 without it. One more
  `npm run sync-vendor` from the main commit that merges DIST-A1 remains: a
  follow-up (DIST-M5b) rather than a finished DIST-M5. A squash or rebase
  merge gives a different commit than 5e4d308, so the follow-up must name
  the main commit. The design's "Provisional contract" section should take
  both this early vendor and `"on_main"` (the first bullet above).
- **"private" is two facts.** The design ties `"private"` to the
  provisional contract alone, so the re-vendor would have made the package
  publishable under an npm name nobody owns yet. `"private"` stays exactly
  while the contract is provisional **or** the name isn't final, and
  `PACKAGE_NAME_FINAL` follows `npm_scope` in `docs/release-checks.json`,
  never the contract (`tests/pack.test.mjs`, `privateProblems` and
  `nameProblems` from DIST-M2's review, which reached the same rule as this
  branch's first commit). So the re-vendor and the npm organization (G-NPM)
  are separate changes in either order; `"published"` in
  `clients/mcp-clients.json` still follows `"private"`.
- **Three release checks, each step named once.** The design has one
  release check, `vendor.test.mjs` refusing a provisional source. Here
  `WISPLY_RELEASE=1 npm test` also runs DIST-M1's and DIST-M2's
  `tests/release-checks.test.mjs` (what a maintainer records in
  `docs/release-checks.json`, the final name without `"private"`, a
  destructive `setup_claude`), DIST-M4's `"published"` check in
  `tests/clients.test.mjs`, and this branch's `tests/release.test.mjs` (the
  release change itself: the version everywhere, the dated CHANGELOG heading,
  the tag). The first version of `tests/release.test.mjs` also checked the
  contract, the name and `"private"`; those now live only in the other two
  files, so a missing step fails once.
- **A dated CHANGELOG and the tag.** The release gate also requires the
  CHANGELOG's top heading to be `## <version> - <YYYY-MM-DD>`, and, in the
  release workflow, the tag to be `v<version>`. Every version bump has to
  open its CHANGELOG section (`## <version> - Unreleased` at least).
- **One integration of DIST-M1 to M4.** This branch merges the latest tips
  of DIST-M2 (3780288), DIST-M3 (f0d3a4d) and DIST-M4 (4727f5a). Each had
  merged DIST-M1's second review (bb46b49) on its own, so they are joined
  first (c140492: DIST-M3 into DIST-M4; c3e65eb: DIST-M2 into both) and
  then merged here, keeping this branch's release workflow, release gate and
  upstream test. Commands that messages name are `COMMAND_PREFIX`
  (`npx -y --prefix / <spec>` once the name is final, `wisply-mcp` until
  then), and DIST-M3's README links, snippets and manifest texts use the
  standard entry (`["-y", "--prefix", "/", "@wisply/mcp@0.1.0"]`). The
  design's own snippets still have neither `--prefix /` nor the exact
  version.
