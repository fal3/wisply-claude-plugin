# Security

## Reporting a problem

Please report security problems privately: use **Report a vulnerability** on
this repository's Security tab (GitHub private vulnerability reporting), or
email support@fallah.io with "security" in the subject. Don't open a public
issue. Include the connector version (`wisply-mcp --version`), the AI app, and
steps to reproduce. Never include a real Wisply token.

Only the newest 0.x release gets fixes.

## What the connector protects, and what it doesn't

**Tokens and scopes.** Wisply issues three loopback tokens:

- `wspc_`: the read-only connector token (memos, search, live transcript,
  action items). Use this one.
- `wspr_`: recording control (start and stop recording, propose a follow-up).
  Start and stop also need Wisply's own "Allow agents to start and stop
  recordings" switch, and a follow-up waits for your confirmation in Wisply.
- `wsp_`: full access. `setup_claude`, which can store an Anthropic API key in
  Wisply, stays hidden unless the connector runs with `--allow-claude-setup`.
  Leave that switch off: in Wisply builds before DIST-A1, the answer to
  `setup_claude` includes a Cursor snippet with Wisply's full-access token
  (the contract vendored here marks the change, `setup_claude_token_free`,
  but older builds don't know it), and the connector passes results on
  unchanged, so the AI app would send the token to its AI service. An
  Anthropic key passed as `api_key` also goes through the AI app and its
  provider; Wisply's Settings are the place for it. The Claude Desktop bundle
  never turns the switch on and doesn't list `setup_claude`, and the
  contract's `distribution` gate leaves it out of every default install.

The connector refuses any tool outside the token's scope, and Wisply refuses
it again (JSON-RPC `-32003`).

**The identity check.** Any program can listen on Wisply's port while Wisply
is closed. Before every use of the token, the connector asks the listener,
without the token, for an HMAC-SHA256 proof over a fresh random nonce and the
port, and checks it for the token's scope in constant time. An answer that is
oversized, isn't HTTP or doesn't prove the token means the token is not sent.

The check has two limits. First, there is a gap between the check and the
call (a listener could change in between, for example if Wisply quits and
another program takes the port). Second, it relies on Wisply holding its port
alone while it runs: the proof binds the token, the port and the nonce, not
the TCP connection, and the check and the call use separate connections. A
program that could listen on `127.0.0.1:<port>` next to Wisply could pass the
check on to Wisply and then receive the token with the call. Wisply's
listener sets `allowLocalEndpointReuse = true` (`MCPServer.swift`), so
whether a second same-user socket can bind that port is still to be checked
on a Mac; if it can, Wisply has to bind the port exclusively before this
connector is released. The release check enforces this: `WISPLY_RELEASE=1 npm
test` fails until `docs/release-checks.json` records, for the Wisply commit
the contract is vendored from, how exclusivity was shown (see "Release
controls"). The default token is read-only, which limits what either gap
could expose.

**Network.** The connector talks only to `127.0.0.1`, with its own HTTP agent
(proxy variables are ignored), never follows redirects, and caps every answer
in size and time. It has no telemetry, crash reporting or update checks.

**Logs.** With `WISPLY_MCP_DEBUG=1`, each request writes one line to stderr
with fixed fields only: method, tool name, outcome code, HTTP status, bytes
and milliseconds. Arguments, results, transcript text and headers are never
logged, and every line is also scrubbed of anything shaped like a token. An
argument (or `WISPLY_MCP_PORT`) that looks like a token, or part of one, is
refused with a fixed message that echoes none of it, because an AI app keeps
the connector's stderr in its log files.

**The token at rest.** Don't put a token in an AI app's config file: those
files end up in Settings Sync, dotfile repositories and backups. Run
`npx -y --prefix / @wisply/mcp@0.1.0 setup`, which keeps it in your login
keychain, or let the app's secret storage pass it as `WISPLY_MCP_TOKEN`.

- The item is a generic password: service `ai.wisply.mcp`, account `token`,
  label "Wisply MCP token", trusting `/usr/bin/security` only (`-T`, never
  `-A`). `setup` first removes every item with that service and account, then
  creates a new one without `-U`: `add-generic-password -U` on an existing item
  would keep that item's access list and only merge `-T` into it, so an item
  made earlier by another tool could keep trusting other programs.
- The item goes to your default keychain, normally the login keychain
  (`add-generic-password` can't name a keychain while it prompts for the
  password). Reads and deletes search your keychain search list, and `forget`
  (like `setup`) repeats the delete until no copy is left, so a second copy in
  another keychain can't keep answering after a successful `forget`.
- The connector reaches it only through `/usr/bin/security`, by absolute path,
  with fixed arguments and this process's environment minus every
  `WISPLY_MCP_*` variable, so a token set in `WISPLY_MCP_TOKEN` never reaches
  the child. `setup` lets `security` prompt for the token in the terminal
  (`-w` as the last argument), so the token is never in an argument list, a
  process listing or the connector's output. Reads come back through a pipe
  and are given up after 2 seconds (a locked keychain or an unanswered macOS
  dialog then counts as "no token").
- `setup` reads the item back once and removes it again when it isn't a Wisply
  token or is the full-access token without `--full-access`. `status` never
  prints the token. `forget` removes the item.
- A full-access or recording-control token in the keychain reaches every AI
  app on this Mac that starts the connector without its own
  `WISPLY_MCP_TOKEN` (Cursor, Windsurf, Zed, Codex, one-click links), with no
  opt-in of its own. With a full-access token, each of them gets full access,
  recording control and follow-ups included. With a recording-control token
  (`wspr_`), each of them can start and stop recordings whenever Wisply's
  "Allow agents to start and stop recordings" switch is on, and propose
  follow-ups. That switch is global: turning it on for one app (Raycast, say)
  lets a prompt-injected agent in any of the others start or stop a meeting
  recording. `setup` and `status` print a note for both scopes; only the
  full-access token also needs `setup --full-access`. If one app should
  control recordings, give it the recording token through its own secret
  storage and keep the read-only connector token in the keychain.

The Keychain item keeps the token out of config files, sync and backups. It
does **not** stop another program running as you on this Mac from reading it,
because the item trusts `/usr/bin/security`. Use the read-only connector
token, and regenerate it in Wisply if you suspect malware.

**Setting up apps.** The app setups (`print-config`, `install`, and the
copies in Wisply and on wisply.ai, all from `clients/mcp-clients.json`) hold
no token and can't: their only placeholders are the connector's arguments,
and `tests/clients.test.mjs` refuses token prefixes, `Bearer`,
`Authorization`, headers and direct HTTP to the port. `install` never reads
the token or the Keychain item, and never writes a token anywhere. Until the
release, `print-config <app>` and `install` print and write nothing, and
`render()` and `installPlan()` throw for any program that bundles
`lib/clients.mjs`: an entry written before then would run `npx -y` of a name
someone else could still register, every time the app starts it.

- An app's own command (`claude`, `codex`, `gemini`, `code`) is found in
  `PATH`'s absolute folders only (an empty or relative entry such as `.`
  would pick up a program from the folder install runs in, a cloned project
  for example) and started by that absolute path with `execFile`, a fixed
  argument list and no shell, in an environment without `WISPLY_MCP_TOKEN`,
  any other value shaped like a token, or relative `PATH` entries.
- In a JSON settings file, install reads the file but changes only the text of
  the `wisply` entry: every other byte stays, so other servers' values (and
  any secrets in them) are kept exactly. It refuses JSONC (comments), repeated
  keys and text that isn't UTF-8, and gives up if the file changes while it
  works (an app saving its settings). The new text goes to a temporary file
  with mode 0600, which gets the file's own mode just before the rename. A
  file with a second hard link is refused: the rename would leave the other
  link with the old text, token included.
- An app's override variable for its settings file (`CLINE_MCP_SETTINGS_PATH`,
  `CLINE_DATA_DIR`, `CLINE_DIR`, `COPILOT_HOME`) counts only as a full path.
  Anything else would be resolved against the folder install or the app runs
  in, so install changes nothing and prints the snippet.
- The one-time backup `<file>.wisply-backup` is a new file with mode 0600,
  and every Wisply token in it is masked (`wsp...`), so install never makes a
  second copy of a token, even next to a file in a dotfiles repository.
  Other servers' keys and tokens stay in it as they were in the file; install
  says so, and to delete the backup once the app works. When
  the old `wisply` entry held a Wisply token in plain text (as the direct-HTTP
  setups that Wisply's own Copy buttons produce until a release switches them
  to this connector do), install replaces it and says so: regenerate the token
  if the file was ever synced or shared. Of the old entry, only fields the
  app or you own (`autoApprove`, `disabled`, `timeout`, `tools` and the like)
  stay, and never one that holds something token-shaped.

**What your AI app does with what it reads.** Whatever the AI app reads from
Wisply goes to the AI service that app uses, under that service's terms.
`print-config` and `install` say so when they set an app up.
Transcripts are recorded speech: treat them as untrusted data.

**Supply chain.** The package has zero runtime dependencies and no lifecycle
scripts (`tests/pack.test.mjs` enforces both). Two things decide which code
your AI app runs under the `wisply` entry:

- **The folder it starts in.** AI apps (Claude Code, Codex, Gemini CLI,
  Cursor, VS Code) start stdio servers in the project you have open, and
  `npx` resolves a package from that folder before it asks npm: a
  `node_modules/@wisply/mcp` anywhere above it (with its `.bin/wisply-mcp`
  link) runs instead of the npm package, with `WISPLY_MCP_TOKEN` in its
  environment, and a project `.npmrc` can point the `@wisply` scope at another
  registry. A cloned repository could bring either. Every snippet and command
  here therefore runs `npx -y --prefix / ...` (`NPX_COMMAND` in
  `lib/constants.mjs`): `npx` then resolves from `/`, the read-only system
  volume on macOS, and installs only from the registry your own `~/.npmrc`
  names. `tests/pack.test.mjs` refuses any `npx` of the package in these
  documents or in `lib/messages.mjs` without those flags, and
  `tests/manifests.test.mjs` in the manifests, `llms-install.md` and every
  file in `skills/`, `commands/` and `extras/` (the skill and the prompts
  name no command at all). Apps that install from the MCP Registry build the
  command from `server.json` themselves (VS Code's gallery runs `npx`, then
  the entry's `runtimeArguments`, then `@wisply/mcp@<version>`, and adds
  nothing of its own), so the entry carries the same flags as
  `runtimeArguments`; `tests/registry.test.mjs` builds that command and
  requires the standard entry. A global install
  (`npm i -g @wisply/mcp@0.1.0`) doesn't read a project's `.npmrc` either.
- **The version.** The snippets in this README (and, once they exist, on
  wisply.ai and in Wisply) run one exact version (`@wisply/mcp@0.1.0`), taken
  from `PACKAGE_SPEC`, and so do the `setup`, `status` and `forget` commands
  the connector's messages name once the npm name is Wisply's (`setup` is the
  command that writes the token to your keychain). npm never lets a published
  version change, so a later release, including a bad one, reaches your app
  only after you change the version in its settings. If you write
  `@wisply/mcp@0` instead, `npx` fetches the newest 0.x release every time
  your app starts the connector: you get fixes on their own, and a bad release
  would run the same way.

`npx` doesn't check npm provenance when it installs a package, so provenance
is an audit trail, not a guard. Publishing is guarded by npm's own controls,
listed under "Release controls" below.

**Where npx finds the package.** `npx` uses a copy of the package that is
already in the folder it starts in (its `node_modules`) before it asks the
registry, and it reads that folder's `.npmrc`, which can point the `@wisply`
scope at another registry. AI apps (Claude Code, Cursor, VS Code and others)
start stdio servers in the project you have open, and they start an entry
from your user settings without asking again. So a cloned repository holding
`node_modules/@wisply/mcp` at the pinned version, or such an `.npmrc`, would
run its own code as the connector as soon as you opened it, with access to
the Keychain item (which trusts `/usr/bin/security`, see above) and your
transcripts. Every setup and every command in these docs therefore runs
`npx -y --prefix / @wisply/mcp@<version>`: with `--prefix /`, npx resolves the
package and reads the project config from `/`, the read-only system volume
on macOS, and gets the package from the registry in your own `~/.npmrc`
(`tests/clients.test.mjs` refuses any setup without it). The strongest setup
skips npx: `npm i -g @wisply/mcp@0.1.0` once, then the absolute path of
`wisply-mcp` as the app's command. Whether each app starts `npx --prefix /`
cleanly is part of the Mac QA before the release.

The Agent Plugin, the Gemini CLI extension and the Claude Desktop bundle in
this repository run the copy of the connector that comes with them (`node
bin/wisply-mcp.mjs`), never `npx`. Whether that copy is pinned depends on how
it was installed:

- **The bundle** is a file, so it changes only when you install another one.
  A bundle downloaded from the GitHub release is not checked against
  `server.json`: the sha256 there (`fileSha256`) is for installers that
  install from the MCP Registry. What protects the download is that the
  release is immutable once published and only the maintainer can create
  `v*` tags. Each release also gives the bundle's sha256 in its notes and in a
  `SHA256SUMS` asset, so you can check a download with
  `shasum -a 256 -c SHA256SUMS`. Both come from the same release, so they show
  that the file is the one published, not who published it.
- **Git installs** (the Agent Plugin in Codex, VS Code and GitHub Copilot CLI,
  and the Gemini CLI extension) copy this repository at a git ref. With a
  release tag (`--ref v0.1.0` in Codex and Gemini CLI) they stay on that
  release, since `v*` tags can't be moved. Without one they copy the default
  branch, `main` (Gemini CLI: the newest release once there is one), and every
  update (`codex plugin marketplace upgrade`, `copilot plugin update`,
  `gemini extensions update` or Gemini's auto-update) copies it again, so a
  push to `main` reaches them. Only the npm snippets and tag-pinned installs
  are version-pinned; for the rest, the guard is the `main` ruleset under
  "Release controls".

Until the contract with Wisply is final and the npm name is Wisply's,
`package.json` is marked `"private"`, so `npm publish` refuses the package.
Until the npm name is Wisply's (`PACKAGE_NAME_FINAL` in `lib/constants.mjs`,
which `tests/pack.test.mjs` ties to `npm_scope` in `docs/release-checks.json`,
never to the contract, so re-vendoring the contract can't flip it), the
connector's messages never name the package: tool errors, which the model also
reads, point only at `WISPLY_MCP_TOKEN`, and terminal messages name the bin
(`wisply-mcp setup`). Nobody, person or agent, is told to `npx` a name someone
else could register first. This README and this file do show the `npx`
commands the first release will print; the README's status note says not to
run them before the release (`tests/pack.test.mjs` keeps it there while the
name isn't final), and release control 1 below covers this repository going
public.

## If you think a token leaked

1. In Wisply, open **Settings > Integrations > MCP Server** and regenerate the
   token (connector, recording or full access). Every client using the old
   token stops working at once.
2. Run `npx -y --prefix / @wisply/mcp@0.1.0 setup` again with the new token,
   or give it to the AI apps that keep it themselves.
   `npx -y --prefix / @wisply/mcp@0.1.0 forget` removes the saved token if you
   don't need it any more.
3. Turn the MCP server off in Wisply if you don't use it. Wisply stops
   answering MCP requests at once; if Wisply Companion is set up, the same
   local listener stays on for it.

## Release controls (maintainers)

Each of these must hold before the step it names. None is met yet: the
package has never been published. Parts of items 1, 3 and 4 are also
machine-checked: `WISPLY_RELEASE=1 npm test` passes only on the tree to
publish and lists every step still missing, each once. It fails while the
contract is provisional or wasn't vendored from a commit on wisply-ai's
`main` (`"on_main"` in `contract/SOURCE.json`; `tests/vendor.test.mjs`);
on the maintainer's machine (outside GitHub Actions), unless
`WISPLY_AI_DIR` and `WISPLY_PLUGIN_DIR` name checkouts of
`github.com/fal3/wisply-ai` and `github.com/fal3/wisply-claude-plugin`
whose `origin/main` has the recorded commits (`tests/upstream.test.mjs`,
which then also compares the vendored bytes with those commits); while the
checkout has changes or untracked files, or npm would pack anything but the
committed files (`tests/pack.test.mjs`); until
`docs/release-checks.json` records the port, registry and npm-name checks,
while `PACKAGE_NAME_FINAL` is false or `package.json` is still `"private"`,
and while the contract leaves `setup_claude` non-destructive
(`tests/release-checks.test.mjs`); while `clients/mcp-clients.json` says
`"published": false` (`tests/clients.test.mjs`); and until the release change
names this version everywhere and dates the CHANGELOG's version heading, and,
in the release workflow, the run is for the tag `v<version>`
(`tests/release.test.mjs`).

`"on_main"` and the sha256 values in `contract/SOURCE.json` are what the
tree says about itself. Only the maintainer's run with both checkouts checks
them against wisply-ai and the plugin. The release workflow can't check out
the private wisply-ai, so there they are the claim of a tree that came
through a reviewed pull request, and the maintainer's run on the tagged
commit, before the tag is pushed, is the check (item 6).

1. **Before anything public names the package** (the wisply.ai guide,
   Wisply's snippets, catalog listings, the connector's own messages, and this
   repository itself: `fal3/wisply-mcp` becoming public, or its README being
   submitted to any catalog, because the README and this file print the `npx`
   commands, `setup` among them): the npm organization `wisply` exists, with
   two-factor authentication required for every member, and the unscoped
   fallback name `wisply-mcp` is held by the same owner, so nobody else can
   register either name and be what `npx -y` runs, or receive the tokens
   people type into a fake `setup`. The Grok sign-up packet for the npm
   organization (with `wisply-mcp` held too) is done before the repository
   goes public. Alex then records `npm_scope` in `docs/release-checks.json`
   (`verified` and `how`) and sets `PACKAGE_NAME_FINAL` to `true` in the same
   change (`tests/pack.test.mjs` ties the two). Until then
   `clients/mcp-clients.json` says `"published": false`, and its copies in
   wisply-ai and wisply-web render nothing from it.
2. **Before the repository is public** (git installs need it public): a
   ruleset on `main` (changes only through pull requests with the `ci` checks
   passing; no force-push and no deletion; signed commits required, or at
   least preferred), a ruleset on `v*` tags (only the owner creates them; no
   update and no deletion), and immutable releases turned on. A release tag
   is created only on a `main` commit whose `ci` run is green (the release
   workflow refuses a tag that isn't on `main`, but it can't see `ci`).
   Also create the GitHub environment `release` now, before any tag
   (Settings > Environments > New environment, `release`):
   - **Required reviewers:** Alex. Leave "Prevent self-review" off while he
     is the only maintainer (it would stop him approving his own tag's run);
     turn it on once a second maintainer can approve.
   - **Deployment branches and tags:** "Selected branches and tags", with one
     tag rule, `v*`, and no branch rule, so no branch run can use the
     environment (npm's trusted publisher checks only the workflow file's
     name and the environment's name, not the ref).
   - **Allow administrators to bypass configured protection rules:** off.

   A workflow run that names an environment that doesn't exist creates it,
   unprotected, so it must exist with these rules before the first tag.
   Check it with
   `gh api repos/fal3/wisply-mcp/environments/release`: `protection_rules`
   has a `required_reviewers` entry, `deployment_branch_policy` says
   `"custom_branch_policies": true`, `can_admins_bypass` is `false`, and
   `gh api repos/fal3/wisply-mcp/environments/release/deployment-branch-policies`
   lists exactly one policy, `"name": "v*"` with `"type": "tag"`.
3. **Before the first publish:** the contract is re-vendored from wisply-ai
   ("Re-vendoring the contract", below), Wisply owns the npm name and
   `PACKAGE_NAME_FINAL` is `true` (item 1), and the release change removes
   `"private": true` from `package.json`, sets `"published": true` in
   `clients/mcp-clients.json` and gives the CHANGELOG's version heading its
   date. `"private"` stays exactly while the contract is provisional or not
   from wisply-ai's `main`, or the name isn't final, and `"published"` follows
   it (`tests/pack.test.mjs`, `tests/clients.test.mjs`), so the re-vendor and
   the npm organization land in either order. The vendored contract marks
   `setup_claude` `destructiveHint: true` (it replaces the Anthropic key
   stored in Wisply; DIST-A1 fixed it in wisply-ai's `MCPToolCatalog.swift`,
   never edit the vendored JSON), and `docs/release-checks.json` records
   `port_exclusive` for the Wisply commit the contract is vendored from:
   either that commit binds the port
   exclusively (`allowLocalEndpointReuse = false`), or a test on a Mac has
   shown that no second socket can listen on Wisply's port while Wisply runs.
   Also: `setup`, `status` and `forget` have passed the manual Keychain QA on
   a Mac (below), and each app in the install list has started
   `npx -y --prefix / ...` on a Mac.

   Manual Keychain QA, from a checkout (`node bin/wisply-mcp.mjs ...`):
   - `setup` with the connector token: one item, and
     `security dump-keychain -a ~/Library/Keychains/login.keychain-db` lists
     only `/usr/bin/security` among its trusted applications. No macOS access
     dialog appears.
   - First create an item with the same service and account and `-A`
     (`security add-generic-password -s ai.wisply.mcp -a token -A -w <synthetic>`),
     then run `setup`: the old item is gone and the new one trusts only
     `/usr/bin/security`.
   - Cancel `setup` at the first prompt (Ctrl-C), with and without an item
     saved before: the message matches what is left.
   - Put a second copy in another keychain on the search list, then run
     `forget`: both go, and `status` reports no token.
   - `setup --full-access` and `status` with that item print the full-access
     note, and `setup` with the recording token and `status` with that item
     print the recording note; `WISPLY_MCP_PORT=eighty forget` still removes
     the item.
   - With Wisply quit, `status` with the connector token in the keychain says
     "not answering" (`UNAVAILABLE`). Then start an impostor that answers on
     the port, `printf 'HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\n{}' | nc -l 51771`
     (or `echo garbage | nc -l 51771`), and run `status` again: "failed the
     identity check" (`NOT_WISPLY`), and the request `nc` prints carries no
     `Authorization` header. A bare `nc -l 51771` accepts the connection and
     never answers, which counts as "not answering" (`UNAVAILABLE`), so it
     doesn't test the impostor case.
4. **Before the first publish, the MCP Registry name.** `package.json`
   `"mcpName"` (`MCP_NAME` in `lib/constants.mjs`, now `ai.wisply/local`) goes
   into the published package and can't change for that version, and the
   registry accepts an `ai.wisply/*` name only from someone who proved control
   of wisply.ai: `mcp-publisher login dns --domain wisply.ai --private-key ...`
   with a `v=MCPv1; k=ed25519; p=<public key>` TXT record on the apex, or
   `mcp-publisher login http` with the same line at
   `https://wisply.ai/.well-known/mcp-registry-auth`. Alex does this (it needs
   the domain and a private key, so no agent can), then records
   `registry_namespace` in `docs/release-checks.json` (`"how": "dns: ..."`).
   If the domain can't be verified, switch `MCP_NAME` and `"mcpName"` to
   `io.github.fal3/wisply-mcp` (verified with `mcp-publisher login github` as
   `fal3`, or as an owner if `fal3` is an organization) before the first
   publish, together with the `name` of `server.json`
   (`tests/manifests.test.mjs` and `tests/registry.test.mjs` tie them).
5. **The first publish** is by hand, by the organization owner, with
   two-factor authentication, from a fresh clone of the release tag (never
   a working checkout: the version it publishes has no provenance and no
   staged review):

   ```bash
   git clone --branch v0.1.0 https://github.com/fal3/wisply-mcp && cd wisply-mcp
   (cd <wisply-ai checkout> && git fetch origin main)
   (cd <wisply-claude-plugin checkout> && git fetch origin main)
   WISPLY_AI_DIR=<wisply-ai checkout> WISPLY_PLUGIN_DIR=<wisply-claude-plugin checkout> WISPLY_RELEASE=1 npm test
   npm pack --dry-run --json      # review the file list against tests/pack.test.mjs
   npm publish --access public --ignore-scripts
   ```

   The release check refuses a clone with changes or untracked files, a
   tarball that isn't exactly the committed files under `"files"`, and a
   missing checkout of either repository.
6. **From the second release,** only the release workflow
   (`.github/workflows/release.yml`) publishes, through npm trusted
   publishing (OIDC: no npm token exists anywhere). It runs only for a pushed
   `v*` tag and only while the repository is public and the repository
   variable `NPM_TRUSTED_PUBLISHING` is `on`, in two jobs. `verify` can only
   read the code: it checks out the whole history without credentials,
   refuses a tagged commit that isn't on `main` (`git merge-base
   --is-ancestor HEAD refs/remotes/origin/main`), installs npm 11.21.0
   without scripts, and runs `npm run check` and `WISPLY_RELEASE=1 npm test`
   (which also requires the tag to be `v<version>`). Only after it passes,
   and after the required reviewer approves the `release` environment,
   `publish`, the only job with `id-token: write`, checks out, installs the
   same npm and **stages** the version with provenance
   (`npm stage publish --provenance --access public --ignore-scripts`). It
   runs nothing but npm itself, so no test, git command or tool can ask for
   the publish-capable OIDC token. A staged version goes live only when a
   maintainer approves it with two-factor authentication:
   `npm stage list @wisply/mcp`, `npm stage download <id>` to inspect the
   tarball if you like, then `npm stage approve <id>` (or npmjs.com > Staged
   Packages > Approve); `npm stage reject <id>` drops it. In the workflow,
   `"on_main"` is the reviewed tree's claim (see above), so run the
   maintainer's release check
   (`WISPLY_AI_DIR=... WISPLY_PLUGIN_DIR=... WISPLY_RELEASE=1 npm test`, as in
   item 5) on the commit before you tag it.

   Setting it up, in one session (npm drops a trusted publisher that hasn't
   published within two days):
   - first, check that the `release` environment exists with its rules
     (item 2: Alex as required reviewer, `v*` tags only, no administrator
     bypass), with the `gh api` commands there. If it doesn't, stop and
     create it: a run would otherwise create it unprotected;
   - on npmjs.com, add the trusted publisher for `fal3/wisply-mcp`, workflow
     filename `release.yml`, environment `release`. Leave its allowed actions
     at the default, `npm stage publish` only: the workflow never runs
     `npm publish`;
   - set the repository variable `NPM_TRUSTED_PUBLISHING` to `on`;
   - push the tag, approve the `release` run, then approve the staged
     version on npm;
   - once a version has gone live with provenance, set the package's
     publishing access to "Require two-factor authentication and disallow
     tokens".

   Every later release goes in this order: approve the `release`
   environment's run, then `npm stage approve <id>`, and only then the
   bundle and the registry entry (item 8; README, "Releasing the bundle";
   for the first release, the steps after the npm publish). `mcp-publisher`
   reads `mcpName` from the live npm version, so a version still waiting in
   the stage can't be published to the registry, and a rejected one must
   never get a bundle or a registry entry.

   `tests/manifests.test.mjs` pins the workflow step by step: tag trigger
   only, `permissions: {}` at the top, `contents: read` alone on `verify`,
   `id-token: write` only on `publish`, which needs `verify` and alone names
   the `release` environment, the ancestry check, every action pinned to the
   same full commit SHA as in `ci.yml`, no caches, no secrets, no
   expressions in shell lines. npm makes provenance only for a public
   repository, which is also the only time the workflow runs. `npx` doesn't
   check provenance, so it is an audit trail, not a guard.
7. **Every release** bumps `version` in `package.json` and `VERSION` in
   `lib/constants.mjs` together, with the versions in `plugin.json`,
   `gemini-extension.json`, `mcpb/manifest.json` and `server.json` (its
   bundle URL included) and the README's links and `--ref` tags
   (`tests/manifests.test.mjs` and `tests/registry.test.mjs` fail until they
   agree), and sets `server.json`'s `fileSha256` back to the placeholder (64
   zeros) until the new bundle exists, so the old release's hash can't be
   published with the new URL, and every `@wisply/mcp@<version>` in
   `clients/mcp-clients.json` (`package_spec`, `standard_entry` and the
   `vscode-inputs` text; `tests/clients.test.mjs` ties them). The snippets
   follow `PACKAGE_SPEC`; copy the clients file on to wisply-ai and
   wisply-web, so the wisply.ai guide and Wisply's snippets name the new
   version.
8. **The Claude Desktop bundle** is built once, in a fresh clone of the
   release tag, with the pinned packer (`npm ci --ignore-scripts --prefix
   tools/mcpb`, from its committed lockfile; never `npx`). `npm run
   build:mcpb` refuses a checkout that has changes or untracked files or isn't
   at the tag, and stages the tag's own files. Both
   `wisply-mcp-<version>.mcpb` and `SHA256SUMS` go to a draft GitHub release
   (never the bundle alone: Gemini CLI takes a release's only asset for the
   extension), the `SHA256SUMS` line goes into the release notes, and the
   sha256 goes into `server.json` before the registry entry is published.
   The gate runs on the asset downloaded back from the draft release:
   `WISPLY_REGISTRY_RELEASE=1 WISPLY_MCPB_FILE=<downloaded .mcpb> npm test`
   must pass. It checks the hash, then unpacks the bundle and compares every
   file with the tag, byte for byte. `WISPLY_REGISTRY_RELEASE=1` fails
   without `WISPLY_MCPB_FILE`: from the second release on, `server.json`
   holds a real hash from the previous release, and the registry never
   compares it with the file (it only checks that the URL answers), so only
   the asset itself shows that the hash is this version's. The build takes
   regular files only: a tracked symlink or a path under a symlinked folder
   stops it, and the manifest's `icon` must be `icon.png`. A rebuilt bundle
   has a different sha256, so never rebuild a released one.
   The packer's dependency tree is pinned by `tools/mcpb/package-lock.json`;
   Dependabot raises security updates for it (`.github/dependabot.yml`; turn
   on Dependabot alerts and security updates in the repository's settings
   when it goes public), and before each bundle build run
   `npm audit --prefix tools/mcpb` and update the lockfile in a reviewed
   change if it reports anything. Version updates stay off: the packer's
   version moves only on purpose.

## Re-vendoring the contract (maintainers)

`contract/mcp-contract.json` is wisply-ai's `Docs/mcp-contract.json`, byte
for byte, at the commit `contract/SOURCE.json` records. The file needs two
wisply-ai PRs: raycast PR 1 (the `wspr_` scope, the error codes,
`live_transcript`, and `tail_words` in the tool catalog) and DIST-A1
(`tool_descriptors` and the `distribution` gate). Either one alone gives a
file the connector can't load, and `npm run sync-vendor` refuses it.

It is vendored now from DIST-A1's commit 5e4d308 (wisply-ai
`claude/distribution-1`, which has raycast PR 1 merged in), before either PR
is on wisply-ai's `main`, so `contract/SOURCE.json` says `"on_main": false`.
That keeps `"private"` in `package.json` and makes `WISPLY_RELEASE=1 npm test`
fail: what ships must be the file wisply-ai's own Mac CI has pinned to the
Swift source on `main` (`MCPContractDescriptorTests`,
`MCPRaycastContractTests`). The re-vendor that clears it:

1. Wait until a wisply-ai `main` commit has both PRs (DIST-A1 merged after
   raycast PR 1) and its Mac CI is green. Fetch it (`git fetch origin
   main`), so the checkout's `origin/main` has it. The checkout's `origin`
   must be `github.com/fal3/wisply-ai`: sync-vendor writes `"on_main":
   false` for any other origin.
2. From a clean checkout of this repository:

   ```bash
   npm run sync-vendor -- --app <wisply-ai checkout> --app-commit <the main commit> \
     --plugin <wisply-claude-plugin checkout> --plugin-commit <its main commit>
   node scripts/build-mcpb.mjs --sync
   WISPLY_AI_DIR=<wisply-ai checkout at that commit> WISPLY_PLUGIN_DIR=<plugin checkout> npm test
   ```

   sync-vendor reads the files with `git show <commit>:<path>`, writes them
   byte for byte with their sha256 in `contract/SOURCE.json`
   (`provisional: false`, and `"on_main": true` when the checkout's
   `origin/main` has the commit), and regenerates `contract/mcp-contract.mjs`.
   A merge that kept 5e4d308 can name that commit; a squash or rebase merge
   needs the main commit. With `WISPLY_AI_DIR`, `tests/upstream.test.mjs`
   checks the vendored file against that commit and the checkout, and
   `"on_main"` against `origin/main`.
3. Do what the tests then ask for. If the file changed in review, the
   descriptors' tests, `tests/skills.test.mjs` (the prompts' tools and
   arguments) and `mcpb/manifest.json` (`--sync` above) follow it; a new tool
   in `distribution.exclude_tools` needs the connector to hide it
   (`tests/contract.test.mjs`). The CHANGELOG's known limitations lose the
   item about `"on_main": false` (the release gate refuses a release section
   that still has it). `docs/release-checks.json`'s `port_exclusive` is
   recorded for the vendored commit, so a new commit asks for it again.
4. Open the PR with the wisply-ai commit and the file's sha256 in its
   description. `"private"` stays until the npm name is final too (release
   control 3).

## If a bad release is published (maintainers)

1. Reject any version still waiting for approval (`npm stage list
   @wisply/mcp`, `npm stage reject <id>`). Publish a fixed patch release at
   once and unpublish the bad version if npm still allows it. Snippets pinned to an earlier version never ran it; for
   anyone who moved to it, update the guide and Wisply's snippets to the fix
   and say which version to write. Installs that use `@wisply/mcp@0` pick up
   the fix at their next start.
2. `npm deprecate @wisply/mcp@<version> "Security issue: update to <fixed>"`.
3. Mark the version deprecated in the MCP Registry.
4. Publish a GitHub security advisory on this repository.
5. Tell users, in the README, on wisply.ai and in the VS Code extension's
   changelog, to regenerate their tokens in Wisply and set them up again.
6. Revoke the trusted publisher and rotate any credential that could have been
   used.
