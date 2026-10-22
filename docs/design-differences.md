# Differences from the distribution design

Where this repository departs from the distribution lane's design
(`2026-10-21-distribution-design.md`), and why, so the spec can be updated.
Not shipped in the npm package.

## The connector, setup, status and forget (DIST-M2)

- **Pinned commands.** The design's texts name the setup, status and forget
  commands with the bare package name, without a version. This package names
  them with `PACKAGE_SPEC` after npx's flags
  (`npx -y --prefix / @wisply/mcp@0.1.0 setup`), as it already
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
- **`WISPLY_RELEASE=1 npm test` fails on purpose until the release.** It
  belongs to the release check, not to `npm run check`, and the ordinary
  `npm test` checks that it fails while the tree isn't releasable. DIST-M5
  made it the whole release gate (`tests/release.test.mjs`, below).

## Plugins, extensions and the bundle (DIST-M3)

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
- **Exact versions.** Snippets, one-click links and the versions note name
  `@wisply/mcp@0.1.0` (`PACKAGE_SPEC`); `@wisply/mcp@0` is only the opt-in
  (DIST-M1). The design's standard entry, per-client snippets, deeplinks and
  the W1 versions-note text still say `@0`, and DIST-M4's templates, the W1
  page and DIST-A1's Swift snippets should follow the exact version.
- **No `setup_claude` in the bundle's tools.** The bundle never passes
  `--allow-claude-setup`, so its manifest (which Claude's directory and
  Smithery read) lists the eight tools it can serve.
- **Token fields say what a full-access token allows.** The connector accepts
  any Wisply token from `WISPLY_MCP_TOKEN`, so the bundle's and the Gemini
  extension's token fields recommend `wspc_` and say that a `wsp_` token lets
  the AI app start and stop recordings and propose follow-ups.
- **Two release assets.** Every release carries the bundle and
  `SHA256SUMS`, and the notes repeat its line. Gemini CLI installs a GitHub
  repository from its newest release: with exactly one asset whose name has
  no platform in it, it takes that asset for the extension and fails to
  unpack a `.mcpb`; with two, it uses the tag's source archive.
- **Release build.** The design packs with
  `npx -y @anthropic-ai/mcpb@2.1.2`; the release build and CI use the copy
  installed from `tools/mcpb`'s lockfile instead, refuse a checkout that
  isn't clean or isn't at the tag, and stage the tag's own files. The gate
  runs on the asset downloaded back from the draft release and compares its
  contents with the tag, not only its sha256.
- **Git installs and `main`.** Git-sourced installs (Agent Plugin, Gemini
  extension) follow the default branch unless they name a ref, so the README
  gives `--ref v<version>` where the app takes one (Codex, Gemini CLI;
  GitHub Copilot CLI's `plugin install` and VS Code's **Install Plugin From
  Source** take none), and the release controls add a `main` ruleset (pull
  requests with CI only, no force-push or deletion, signed commits) to the
  design's `v*` tag ruleset and immutable releases.

## Release workflow and the re-vendor (DIST-M5)

- **The contract isn't re-vendored yet.** The design has DIST-M5 re-vendor
  from DIST-A1's merge commit. Neither DIST-A1 (`claude/distribution-1`,
  d44a9e5) nor raycast PR 1 (`claude/raycast-1`, 477de80) is on wisply-ai's
  `main`, and each creates `Docs/mcp-contract.json` with half of what the
  connector needs: DIST-A1 has `tool_descriptors` but no `wspr_` scope,
  error codes or `live_transcript` (it was written before raycast PR 1
  existed), raycast PR 1 has those but no descriptors. The connector refuses
  to load either (`lib/contract.mjs`), so `contract/SOURCE.json` stays
  provisional and the release gate stays closed. `npm run sync-vendor` now
  refuses both before it writes anything, and `tests/sync-vendor.test.mjs`
  shows that the expected union of the two (raycast PR 1's keys, DIST-A1's
  descriptors, `tail_words` in `get_live_transcript`) is vendored byte for
  byte with `provisional: false`. The re-vendor itself is a follow-up PR from
  the wisply-ai `main` commit that has both ("Re-vendoring the contract" in
  SECURITY.md).
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
  together with "disallow tokens".
- **More hardening than the design's YAML.** `package-manager-cache: false`
  on setup-node (npm's and setup-node's advice for release builds),
  `timeout-minutes`, `--ignore-scripts` on the publish, and comments. The
  publish job's `if` and permissions are the design's.
- **"private" is two facts.** DIST-M2 tied `"private"` to the provisional
  contract and `PACKAGE_NAME_FINAL` to `"private"`, so the re-vendor would
  also have had to declare the npm name final. Now `"private"` stays exactly
  while the contract is provisional **or** the name isn't final
  (`tests/pack.test.mjs`), so the re-vendor and the npm organization (G-NPM)
  are separate changes in either order; `"published"` in
  `clients/mcp-clients.json` still follows `"private"`.
- **A dated CHANGELOG and the tag.** The release gate also requires the
  CHANGELOG's top heading to be `## <version> - <YYYY-MM-DD>`, and, in the
  release workflow, the tag to be `v<version>`. Every version bump has to
  open its CHANGELOG section (`## <version> - Unreleased` at least).
- **One integration of DIST-M1 to M4.** DIST-M3 and DIST-M4 were built on
  DIST-M2 before its review fixes, so this branch merges them. Commands that
  messages name are `COMMAND_PREFIX` (`npx -y --prefix / <spec>` once the
  name is final, `wisply-mcp` until then: DIST-M2's gate with DIST-M4's
  flags), and DIST-M3's README links, snippets and manifest texts use
  DIST-M4's standard entry (`["-y", "--prefix", "/", "@wisply/mcp@0.1.0"]`).
  The design's own snippets still have neither `--prefix /` nor the exact
  version.
