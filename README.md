# Wisply MCP connector (`@wisply/mcp`)

Use your Wisply meeting notes, action items and live transcript in any MCP
client (Cursor, VS Code, Claude, Codex, Gemini CLI, Zed and others) on the
Mac that runs [Wisply](https://www.wisply.ai). The connector is a small stdio
MCP server. It talks only to the Wisply app at `127.0.0.1`, checks that it is
talking to Wisply before it uses your token, and needs no account.

> **Status: not released yet.** This package isn't on npm, and the name
> `@wisply/mcp` is a placeholder until it is (the `wisply` npm organization
> doesn't exist yet). Its contract with the Wisply app is provisional
> (transcribed from the app's tool catalog), so `package.json` is marked
> `"private"`, which makes `npm publish` refuse it, and
> `WISPLY_RELEASE=1 npm test` fails. Until the name is Wisply's on npm
> (`PACKAGE_NAME_FINAL` in `lib/constants.mjs`), the connector's own messages
> never name it: errors in your AI app point at `WISPLY_MCP_TOKEN`, and
> terminal messages say `wisply-mcp setup`, `wisply-mcp print-config` and so
> on (from a checkout: `node bin/wisply-mcp.mjs setup`). The `npx` commands
> below are what the first release will print.

## What you need

- Wisply for Mac with **Settings > Integrations > MCP Server > Enable MCP
  server on this Mac** turned on.
- Node.js 20 or later (tested on 22 and 24).
- A Wisply token. Use the **read-only connector token** (`wspc_...`) unless you
  need recording control.

## Add it to your AI app

Every client runs the same token-free entry:

```json
{ "command": "npx", "args": ["-y", "--prefix", "/", "@wisply/mcp@0.1.0"] }
```

For example, in `~/.cursor/mcp.json`:

```json
{ "mcpServers": { "wisply": { "command": "npx", "args": ["-y", "--prefix", "/", "@wisply/mcp@0.1.0"] } } }
```

or in Claude Code: `claude mcp add --scope user wisply -- npx -y --prefix / @wisply/mcp@0.1.0`.

Install Wisply once per app. Two entries named `wisply` show the tools twice.

**Why `--prefix /`.** AI apps start the connector in the project you have
open, and `npx` looks for a package in that folder (its `node_modules`, and
its `.npmrc`, which can send the `@wisply` scope to another registry) before
it asks npm. Without the flag, a cloned project could bring its own
`@wisply/mcp` and have it run under the `wisply` entry you already trust,
with your token. `--prefix /` makes `npx` resolve from `/`, the read-only
system volume on macOS, so only the npm registry (through your own
`~/.npmrc`) supplies the package. One side effect: npm then reads
`/etc/npmrc` instead of the `etc/npmrc` of your Node installation; settings
in `~/.npmrc` still apply. Every command below uses the same flags.

### Every app's setup, from the connector

`npx -y --prefix / @wisply/mcp@0.1.0 print-config <app>` prints the setup for
one app (on stdout, so `| pbcopy` copies just the snippet) and says where it
goes (on stderr). `npx -y --prefix / @wisply/mcp@0.1.0 print-config` lists the
apps. Add `--port <n>` if Wisply uses another port.

`npx -y --prefix / @wisply/mcp@0.1.0 install <app>` adds the same entry for
you, for the apps marked "yes" below. Quit the app first: an app that is open
can write its settings back over the change. `install` either runs the app's
own command, found by its full path in your `PATH` (folders given as relative
paths, such as `.`, are skipped), with a fixed argument list and no shell; or,
for apps with a plain JSON settings file, it changes the text of the `wisply`
entry and nothing else. Every other byte of the file stays as it was (its
layout, number spellings and other servers). A file with comments, a key that
appears twice or text that isn't UTF-8 is left alone, and you get the snippet
to paste. Before the
first change it saves the file as `<file>.wisply-backup`, readable only by
you, with any Wisply token in it masked as `wsp...`. It replaces the file in
one step, following a symlink to a dotfiles copy, and only if nothing else
wrote the file while it worked. It never reads the token or the Keychain item,
and never writes a token or passes one on: the app's command starts without
`WISPLY_MCP_TOKEN` in its environment. For the other apps it prints the
snippet to paste.

| App | `<app>` | Where the setup goes | `install` |
|---|---|---|---|
| Claude Code | `claude-code` | `claude mcp add --scope user wisply -- npx ...` | yes |
| Claude Desktop | `claude-desktop` | `~/Library/Application Support/Claude/claude_desktop_config.json` | yes |
| Cursor | `cursor` | `~/.cursor/mcp.json` | yes |
| VS Code | `vscode` | user `mcp.json`, through `code --add-mcp`; `vscode-inputs` keeps the token in VS Code's secret storage instead | yes |
| Windsurf | `windsurf` | `~/.codeium/windsurf/mcp_config.json` | yes |
| Zed | `zed` | Zed `settings.json` (`context_servers`; **zed: open settings**). The file usually has comments, so `install` doesn't edit it | |
| JetBrains AI Assistant | `jetbrains` | Settings > Tools > AI Assistant > Model Context Protocol (MCP) | |
| Codex | `codex` | `codex mcp add wisply -- npx ...`, or `~/.codex/config.toml` | yes |
| Gemini CLI | `gemini-cli` | `gemini mcp add --scope user wisply npx -- ...` | yes |
| GitHub Copilot CLI | `copilot-cli` | `~/.copilot/mcp-config.json` (or `$COPILOT_HOME`) | yes |
| Warp | `warp` | Settings > AI > Manage MCP Servers, or `/add-mcp` | |
| Cline | `cline` | `cline_mcp_settings.json`. `install` sets up the Cline CLI (`~/.cline/data/settings/`, or `CLINE_MCP_SETTINGS_PATH`); for the Cline extension, add the entry in Cline: MCP Servers > Configure > Configure MCP Servers | yes |
| Roo Code | `roo-code` | global MCP settings, or `.roo/mcp.json` | |
| Goose | `goose` | `~/.config/goose/config.yaml` | |
| LM Studio | `lm-studio` | Program > Install > Edit mcp.json | |
| Kiro | `kiro` | `~/.kiro/settings/mcp.json` | |
| opencode | `opencode` | `~/.config/opencode/opencode.json` | |
| Amp | `amp` | `amp mcp add wisply -- npx ...` | |
| Factory | `factory` | `droid mcp add wisply "npx ..."` | |
| Grok CLI | `grok-cli` | `grok mcp add wisply -- npx ...` | |

The setups come from [`clients/mcp-clients.json`](clients/mcp-clients.json),
checked against each app's documentation on the date in its `verified_on`
field. Wisply's own Settings and the guide on
[wisply.ai/docs/mcp/install](https://www.wisply.ai/docs/mcp/install) use
copies of the same file. None of the setups contains a token.

**Don't paste a token into a config file.** Config files end up in Settings
Sync, dotfile repositories and backups. Run
`npx -y --prefix / @wisply/mcp@0.1.0 setup` once to keep the token in your
login keychain (next section), or let the app's own secret storage set
`WISPLY_MCP_TOKEN` (Wisply's VS Code extension, Claude Desktop bundle and
Gemini CLI extension, which come with the first release, work this way).

Three notes:

- **GUI apps and `npx`.** Apps started from the Dock may not see a Node
  installed through nvm. Install Node from nodejs.org or Homebrew; or run
  `npm i -g @wisply/mcp@0.1.0` and use the full path that `which wisply-mcp`
  prints as the `"command"` (with no `"args"`), which also never resolves
  anything from a project folder; or use the Claude Desktop bundle or the VS
  Code extension, which bring their own Node.
- **Remote windows.** In a VS Code Remote-SSH or Dev Container window, add
  Wisply to your **local** user configuration. A server started on the remote
  machine can't reach Wisply on your Mac.
- **Versions.** The snippets, and every command in this README, name one
  exact version (`@wisply/mcp@0.1.0`). npm never changes a published version,
  so your app runs the same connector until you change the version in its
  settings (the guide on wisply.ai and Wisply's own snippets will show the
  newest one). If you'd rather get every 0.x release on its own, write
  `@wisply/mcp@0`: `npx` then fetches the newest 0.x release each time your app
  starts the connector, which means a bad release would run the same way.

## Keep the token in your login keychain

Run this once in Terminal:

```bash
npx -y --prefix / @wisply/mcp@0.1.0 setup
```

The setup, status and forget commands run the same exact version, with the
same `--prefix /`, as the snippets, so the command that decides which token
your apps get never runs whatever npm has as its newest release, or a copy of
the package in the folder Terminal is in.

Setup first removes any "Wisply MCP token" saved before, so the new item
starts with a clean access list. Then macOS's own `security` tool asks for the
token twice and stores it in your keychain as "Wisply MCP token" (service
`ai.wisply.mcp`, account `token`; your default keychain, which is normally the
login keychain). The token never passes through the connector's arguments or
output. If you cancel at that point, the token saved before is already gone,
and setup says so. Setup then reads the item back once:

- A full-access token (`wsp_...`) is removed again unless you run
  `npx -y --prefix / @wisply/mcp@0.1.0 setup --full-access`. Use the
  read-only connector token: a full-access token in the keychain gives full
  access (recording control and follow-ups) to every AI app on this Mac that
  starts the connector without its own `WISPLY_MCP_TOKEN`, and setup and
  status say so.
- Anything that isn't a Wisply token is removed again.
- A kept token gets the identity check, and setup says what it found:
  "Stored. Wisply answered on 127.0.0.1:51771 and proved it holds this token
  (read-only connector: 4 tools)."

Don't pass the token as an argument (`setup wspc_...`, or in an app's `args`):
arguments end up in shell history, config files and logs. The connector
refuses such an argument without echoing any of it, and asks you to
regenerate the token.

From then on, every AI app that starts the connector without
`WISPLY_MCP_TOKEN` uses the saved token, so none of their configs holds a
secret. Two more commands:

- `npx -y --prefix / @wisply/mcp@0.1.0 status` shows where the token comes
  from, its scope, the port, whether Wisply answered and proved it holds the
  token, and the tools your apps get. It never prints the token. It takes the
  connector's `--port`, `--read-only` and `--allow-claude-setup` options.
- `npx -y --prefix / @wisply/mcp@0.1.0 forget` removes the saved token, every
  copy of it in your keychains. It ignores `WISPLY_MCP_PORT`. Connectors that
  are already running keep the token until their app restarts them;
  regenerating the token in Wisply cuts every app off at once. On another
  system there is no saved token (setup only saves one on a Mac), so forget
  says so and succeeds.

The commands exit 0 when they're done (status: a token was found and Wisply
proved it holds it), 1 when something needs your attention (no token, Wisply
isn't answering, or setup or status on a computer that isn't a Mac; the
message says which), and 2 for a usage mistake, such as an unknown option or a
token passed as an argument.

What the keychain protects: it keeps the token out of config files, Settings
Sync, dotfile repositories and backups. It doesn't stop another program
running as you on this Mac from reading it, because the item trusts
`/usr/bin/security`. Use the read-only connector token, and regenerate it in
Wisply if you suspect malware.

AI apps read the tool list when they start the connector. After the token
changes, restart the connector (or the app) in each AI app that was already
running.

## Tokens and tools

Wisply has three tokens. The connector lists and calls only what the token
allows, and Wisply enforces the same rule.

| Token | Prefix | Tools |
|---|---|---|
| Read-only connector (recommended) | `wspc_` | `list_memos`, `search_transcripts`, `get_live_transcript`, `get_action_items` |
| Recording control | `wspr_` | `start_recording`, `stop_recording`, `propose_follow_up` |
| Full access | `wsp_` | all of the above, plus `get_action_proposal_status`; `setup_claude` only with `--allow-claude-setup` |

- `start_recording` and `stop_recording` also need **Allow agents to start and
  stop recordings** in Wisply. `propose_follow_up` only proposes: nothing
  happens until you confirm it in Wisply.
- `setup_claude` is hidden unless you start the connector with
  `--allow-claude-setup`, because it can store an Anthropic API key in Wisply.
- Without a token, the connector still lists the four read-only tools (so
  clients and catalogs can show them) and answers each call with the setup
  steps.
- The list is fixed when your app starts the connector. After you switch to a
  token with more tools, restart the connector in your app.

## Options

| Flag | Variable | Meaning |
|---|---|---|
| | `WISPLY_MCP_TOKEN` | The Wisply token. Empty, or an unresolved `${...}` placeholder, counts as unset, and then the token saved by `setup` is used. |
| `--port <n>` | `WISPLY_MCP_PORT` | Wisply's MCP port, 1024-65535. Default `51771`. The host is always `127.0.0.1`. |
| `--read-only` | | Offer only the four read-only tools, whatever the token allows. |
| `--allow-claude-setup` | `WISPLY_MCP_ALLOW_CLAUDE_SETUP=1` | Offer `setup_claude` with a full-access token. |
| | `WISPLY_MCP_DEBUG=1` | One line per request on stderr: method, tool, outcome, HTTP status, bytes, milliseconds. Never arguments, results, transcript text or tokens. |
| `--help`, `--version` | | |

## How it protects your token

- **Identity check before every use.** Any program can listen on Wisply's
  port while Wisply is closed. Before each call the connector asks the
  listener, without the token, to prove it holds the same token: an
  HMAC-SHA256 over a fresh random nonce, bound to the port. The proof is
  checked for your token's own scope, in constant time. Only then is the
  token sent, as a bearer header. The check relies on Wisply holding its port
  alone while it runs (see [SECURITY.md](SECURITY.md)).
- **Local answers.** `initialize`, `ping` and `tools/list` are answered by the
  connector itself, from the tool descriptions in this package, never from
  whatever answers on the port.
- **Loopback only.** The host is fixed at `127.0.0.1`. Requests use their own
  HTTP agent, so `HTTP_PROXY` and `NODE_USE_ENV_PROXY` can't route them
  elsewhere, and redirects are never followed. Answers are capped at 2 MiB
  (8 KiB for the identity check), with 3 s for the identity check, 5 s for the
  live transcript and 30 s for everything else.
- **No dependencies, no install scripts, no telemetry.** The package has zero
  runtime dependencies and no lifecycle scripts. It sends nothing anywhere
  except `127.0.0.1`.
- **A pinned version, from npm only.** The snippets run one exact,
  unchangeable npm version, so a new release reaches your app only when you
  choose it, and `--prefix /` keeps the open project's `node_modules` and
  `.npmrc` from supplying another copy.

## Privacy

The connector talks only to the Wisply app on this Mac, at 127.0.0.1. When
your AI app reads a memo, it sends what it read to the AI service it uses,
under that service's terms. The connector collects no analytics and keeps no
logs of your memos. `npx` downloads the connector from npm when your app
starts it.

Transcripts are recorded speech: the connector tells the model to treat them
as data, never as instructions, and the recording and follow-up tools act only
with Wisply's own switches and your confirmation in Wisply.

## When something goes wrong

The connector answers with a plain message instead of a result:

- **"Wisply MCP token is not set"**: copy the connector token from Wisply >
  Settings > Integrations > MCP Server and run
  `npx -y --prefix / @wisply/mcp@0.1.0 setup`, or give it to your app's secret
  storage (see above).
- **"Wisply isn't answering on 127.0.0.1:51771"**: open Wisply and turn on the
  MCP server.
- **"Wisply identity check failed"**: the program on the port couldn't prove
  it holds your token, so the token wasn't sent. If you regenerated the token
  in Wisply, run `npx -y --prefix / @wisply/mcp@0.1.0 setup` again (or update
  it in your app). Otherwise quit whatever uses that port.
- **"Wisply couldn't run ..."**: Wisply answered the call with an error. The
  connector passes on Wisply's error code but never Wisply's own error text.
- **"This version of Wisply has no identity check"**: update Wisply.
- **"... doesn't know recording-control tokens (wspr_), or couldn't read
  yours from the Keychain"**: update Wisply, or quit and reopen it and copy
  the recording token again; or use the connector token.
- **"Wisply on 127.0.0.1:51771 couldn't read its MCP tokens from the
  Keychain"**: quit and reopen Wisply, and allow Keychain access if macOS
  asks.
- **"... isn't available with your ... token"**: the tool needs another token.

`npx -y --prefix / @wisply/mcp@0.1.0 status` runs the same checks and says
which one failed. On other platforms the connector explains that it needs
Wisply for Mac on the same computer.

## Development

Zero dependencies: there's nothing to install.

```bash
npm test                 # node --test tests/*.test.mjs
npm run check            # the tests, then npm pack --dry-run
# drift checks against local checkouts of the app and the Claude plugin:
WISPLY_AI_DIR=../wisply-ai WISPLY_PLUGIN_DIR=../wisply-claude-plugin npm test
```

- `contract/mcp-contract.json` is vendored from wisply-ai `Docs/mcp-contract.json`,
  and `lib/identity.mjs` from `wisply-claude-plugin`, both by
  `npm run sync-vendor` (see `scripts/sync-vendor.mjs`), which records their
  sha256 in `contract/SOURCE.json`. Don't edit them by hand.
- `contract/mcp-contract.mjs` and `clients/mcp-clients.mjs` are generated by
  `npm run gen-data`.
- `clients/mcp-clients.json` is the source of every app setup (`print-config`,
  `install`). wisply-ai keeps a byte-identical copy at `Docs/mcp-clients.json`
  (the upstream test compares them once it exists) and wisply-web a hashed
  one, so change it here first and copy it on. Its templates may use only the
  `{{args_list}}` and `{{args_cli}}` placeholders; `tests/clients.test.mjs`
  refuses anything that could carry a token, and any entry without
  `--prefix /` in front of the exact version.
- Its `"published": false` says the package name isn't on npm yet. The copies
  in wisply-ai and wisply-web render nothing from the file while it is false
  (their own tests check that), because anyone could still register the name
  and be what `npx -y` runs. It turns `true` in the release change, together
  with removing `"private"` from `package.json` (`tests/clients.test.mjs` ties
  the two, and `WISPLY_RELEASE=1 npm test` requires `true`).
- Every release updates the version in `package.json`, `lib/constants.mjs`
  and every `@wisply/mcp@<version>` in `clients/mcp-clients.json`
  (`package_spec`, `standard_entry` and the `vscode-inputs` text); the tests
  fail while one is behind.
- `docs/release-checks.json` records the checks no file here can prove (the
  Mac port test, the MCP Registry namespace); `WISPLY_RELEASE=1 npm test`
  fails until they are recorded. `docs/design-differences.md` lists where this
  repository departs from the distribution design. Neither is in the package.
- `tests/fixtures/fake-wisply.mjs` is a synthetic Wisply for local runs:
  `node tests/fixtures/fake-wisply.mjs` prints its port and synthetic tokens.
- `install` is tested against a temporary `HOME` and a temporary `PATH`
  folder with a stand-in for every app's command; no test runs a real
  `claude`, `codex`, `gemini` or `code`, or touches your own app settings.
- No test touches a real keychain. The Keychain code is tested with spies and
  plain `node` children standing in for `/usr/bin/security`; on a Mac, the few
  tests that would run the real `security` are skipped. `setup`, `status` and
  `forget` against a real login keychain are manual QA on a Mac, from a
  checkout: `node bin/wisply-mcp.mjs setup`, `node bin/wisply-mcp.mjs status`,
  `node bin/wisply-mcp.mjs forget` (the checks are listed in
  [SECURITY.md](SECURITY.md), "Release controls").

Security reports: see [SECURITY.md](SECURITY.md). License: [MIT](LICENSE).
