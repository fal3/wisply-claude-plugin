# Wisply MCP connector (`@wisply/mcp`)

Use your Wisply meeting notes, action items and live transcript in any MCP
client (Cursor, VS Code, Claude, Codex, Gemini CLI, Zed and others) on the
Mac that runs [Wisply](https://www.wisply.ai). The connector is a small stdio
MCP server. It talks only to the Wisply app at `127.0.0.1`, checks that it is
talking to Wisply before it uses your token, and needs no account.

> **Status: not released yet.** This package isn't on npm, and the name
> `@wisply/mcp` is a placeholder until it is (the `wisply` npm organization
> doesn't exist yet). Nobody owns that name on npm yet, so don't run the
> `npx` commands below before the first release: until Wisply owns the name,
> whoever registers it first would receive the token you type into `setup`.
> The contract with the Wisply app is provisional (transcribed from the
> app's tool catalog). `package.json` stays `"private"`, which makes
> `npm publish` refuse it, until the contract is final and the name is
> Wisply's, and `WISPLY_RELEASE=1 npm test` fails. Until the name is Wisply's
> on npm (`PACKAGE_NAME_FINAL` in `lib/constants.mjs`), the connector's own
> messages never name it: errors in your AI app point at `WISPLY_MCP_TOKEN`,
> and terminal messages say `wisply-mcp setup`, `wisply-mcp print-config` and
> so on (from a checkout: `node bin/wisply-mcp.mjs setup`). For the same
> reason `print-config <app>` and `install` print and add nothing yet (exit
> 1): every setup runs the connector through `npx`, from a name that isn't
> Wisply's on npm yet. The `npx` commands below are what the first release
> will print.

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
One-click links, plugins and the setup for each app are under
[Install in your AI app](#install-in-your-ai-app), and on
[wisply.ai/docs/mcp/install](https://www.wisply.ai/docs/mcp/install).

### Every app's setup, from the connector

`npx -y --prefix / @wisply/mcp@0.1.0 print-config <app>` prints the setup for
one app (on stdout, so `| pbcopy` copies just the snippet) and says where it
goes (on stderr). `npx -y --prefix / @wisply/mcp@0.1.0 print-config` lists the
apps. Add `--port <n>` if Wisply uses another port. `print-config` and
`install` take the port only from `--port`: a `WISPLY_MCP_PORT` in your shell
(for a test Wisply, say) is ignored, with a note, so it never ends up in an
app's settings without you choosing it.

`npx -y --prefix / @wisply/mcp@0.1.0 install <app>` adds the same entry for
you, for the apps marked "yes" below. Quit the app first: an app that is open
can write its settings back over the change. `install` either runs the app's
own command, found by its full path in your `PATH` (folders given as relative
paths, such as `.`, are skipped), with a fixed argument list and no shell; or,
for apps with a plain JSON settings file, it changes the text of the `wisply`
entry and nothing else. Every other byte of the file stays as it was (its
layout, number spellings and other servers). A file with comments, a key that
appears twice or text that isn't UTF-8 is left alone, and you get the snippet
to paste. When it
replaces an old `wisply` entry, it keeps what the app or you set on it
(`autoApprove`, `alwaysAllow`, `disabled`, `disabledTools`, `timeout`,
`tools`, unless one holds something token-shaped) and names every other old
field it didn't carry over, such as `env` or `url`. An entry that already
matches, in any key order, is left as it is. Before the first change it saves
the file as `<file>.wisply-backup`, readable only by you, with any Wisply
token in it masked as `wsp...`. Other servers' keys and tokens stay in that
copy, as they were in the file, so delete it once the app works with Wisply.
It writes the new text to a temporary file readable only by you and replaces
the file in one step, following a symlink to a dotfiles copy, and only if
nothing else wrote the file while it worked. A file with a second hard link
is left alone, because replacing it would leave the other copy as it was. It
never reads the token or the Keychain item, and never writes a token or
passes one on: the app's command starts without `WISPLY_MCP_TOKEN` in its
environment. For the other apps it prints the snippet to paste.

An app's own override variable decides the file, as it does for the app:
Cline's `CLINE_MCP_SETTINGS_PATH`, then `CLINE_DATA_DIR`, then `CLINE_DIR`;
GitHub Copilot CLI's `COPILOT_HOME`. install says when one is set, and
refuses a value that isn't a full path (the app would resolve it against
whatever folder it runs in). `claude mcp add` refuses a name it already has,
so running `install claude-code` again exits 1 and says how to replace the
entry (`claude mcp remove wisply`); `codex` and `gemini` replace it, and a
JSON file that already has the entry exits 0.

Once an app has the entry, what it reads from Wisply, transcripts included,
goes to the AI service it uses; `print-config` and `install` say so too.

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
| Cline | `cline` | `~/.cline/data/settings/cline_mcp_settings.json`, which Cline 4.0 and later share between the extension, the CLI and the JetBrains plugin (or the file `CLINE_MCP_SETTINGS_PATH`, `CLINE_DATA_DIR` or `CLINE_DIR` points to); in Cline: MCP Servers > Configure > Configure MCP Servers | yes |
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
- A recording-control token (`wspr_...`) is kept, and setup and status say
  what that means: every AI app on this Mac that starts the connector without
  its own `WISPLY_MCP_TOKEN` can then start and stop recordings whenever
  Wisply's **Allow agents to start and stop recordings** is on (turning it on
  for one app, such as Raycast, turns it on for all of them) and propose
  follow-ups. If only one app should control recordings, give that app the
  recording token through its own secret storage instead, and keep the
  read-only connector token in the keychain.
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
proved it holds it; install: the entry was added, or the JSON file already had
it), 1 when something needs your attention (no token, Wisply isn't answering,
setup, status or install on a computer that isn't a Mac, an app's own command
that refused; the message says which), and 2 for a usage mistake, such as an
unknown option or app, or a token passed as an argument.

What the keychain protects: it keeps the token out of config files, Settings
Sync, dotfile repositories and backups. It doesn't stop another program
running as you on this Mac from reading it, because the item trusts
`/usr/bin/security`. Use the read-only connector token, and regenerate it in
Wisply if you suspect malware.

AI apps read the tool list when they start the connector. After the token
changes, restart the connector (or the app) in each AI app that was already
running.

## Install in your AI app

Run `npx -y --prefix / @wisply/mcp@0.1.0 setup` once (above), then add
Wisply to each app in one of the ways below. None of them holds a token: they
all use the token saved by `setup`, or the one your app keeps in its own
secret storage.

### One click

[<img src="https://cursor.com/deeplink/mcp-install-dark.svg" alt="Add Wisply to Cursor" height="32">](https://cursor.com/en/install-mcp?name=wisply&config=eyJjb21tYW5kIjoibnB4IiwiYXJncyI6WyIteSIsIi0tcHJlZml4IiwiLyIsIkB3aXNwbHkvbWNwQDAuMS4wIl19)
[<img src="https://img.shields.io/badge/VS_Code-VS_Code?style=flat-square&label=Install%20Wisply&color=0098FF" alt="Install Wisply in VS Code">](https://insiders.vscode.dev/redirect?url=vscode%3Amcp%2Finstall%3F%257B%2522name%2522%253A%2522wisply%2522%252C%2522command%2522%253A%2522npx%2522%252C%2522args%2522%253A%255B%2522-y%2522%252C%2522--prefix%2522%252C%2522%252F%2522%252C%2522%2540wisply%252Fmcp%25400.1.0%2522%255D%257D)
[<img src="https://img.shields.io/badge/VS_Code_Insiders-VS_Code_Insiders?style=flat-square&label=Install%20Wisply&color=24bfa5" alt="Install Wisply in VS Code Insiders">](https://insiders.vscode.dev/redirect?url=vscode-insiders%3Amcp%2Finstall%3F%257B%2522name%2522%253A%2522wisply%2522%252C%2522command%2522%253A%2522npx%2522%252C%2522args%2522%253A%255B%2522-y%2522%252C%2522--prefix%2522%252C%2522%252F%2522%252C%2522%2540wisply%252Fmcp%25400.1.0%2522%255D%257D)
[<img src="https://block.github.io/goose/img/extension-install-dark.svg" alt="Install Wisply in Goose" height="32">](https://block.github.io/goose/extension?cmd=npx&arg=-y&arg=--prefix&arg=%2F&arg=%40wisply%2Fmcp%400.1.0&id=wisply&name=Wisply&description=Your%20Wisply%20meeting%20notes%20from%20the%20Wisply%20app%20on%20this%20Mac&timeout=300)
[<img src="https://files.lmstudio.ai/deeplink/mcp-install-light.svg" alt="Add Wisply to LM Studio" height="32">](https://lmstudio.ai/install-mcp?name=wisply&config=eyJjb21tYW5kIjoibnB4IiwiYXJncyI6WyIteSIsIi0tcHJlZml4IiwiLyIsIkB3aXNwbHkvbWNwQDAuMS4wIl19)
[<img src="https://kiro.dev/images/add-to-kiro.svg" alt="Add Wisply to Kiro" height="32">](https://kiro.dev/launch/mcp/add?name=wisply&config=%7B%22command%22%3A%22npx%22%2C%22args%22%3A%5B%22-y%22%2C%22--prefix%22%2C%22%2F%22%2C%22%40wisply%2Fmcp%400.1.0%22%5D%7D)

These buttons add the standard entry, which runs `@wisply/mcp@0.1.0` from npm
each time your app starts the connector (see "Versions" above).

### Plugins, extensions and the Claude Desktop bundle

These run the copy of the connector that comes with them, never `npx`. An
install from this repository copies it at a git ref. Name the release tag
where your app takes one, so a later change reaches you only when you move to
a newer release; without a ref, the app copies what is on `main` at install
and again at each update.

- **Agent Plugin** (Codex, Cursor, VS Code, GitHub Copilot CLI): this
  repository is one plugin (`plugin.json`, `mcp.json` and the
  `wisply-memos` skill). Codex:
  `codex plugin marketplace add fal3/wisply-mcp --ref v0.1.0`, then install
  **wisply** in `/plugins` (`codex plugin marketplace upgrade` fetches the
  same tag again). VS Code: **Chat: Install Plugin From Source** with
  `https://github.com/fal3/wisply-mcp`, or `/plugin install fal3/wisply-mcp`
  in a Copilot chat. GitHub Copilot CLI:
  `copilot plugin install fal3/wisply-mcp`. These two take no ref: they copy
  `main` at install and again at each update (`copilot plugin update`).
  Cursor: from the Cursor Marketplace once it's listed. The plugin starts
  `node`, so Node.js 20 or later must be on the app's `PATH` (see "GUI apps
  and `npx`" above).
- **Gemini CLI extension**:
  `gemini extensions install https://github.com/fal3/wisply-mcp --ref v0.1.0`.
  Without `--ref`, Gemini installs the newest GitHub release (`main` until
  there is one), and `gemini extensions update` moves to newer ones.
  Gemini asks for an optional Wisply token and keeps it in the system
  keychain; leave it empty to use the token saved by `setup` (Gemini then
  says the setting is missing, which is expected). It adds the
  skill and three commands: `/wisply:recap`, `/wisply:live` and
  `/wisply:find <phrase>`.
- **Claude Desktop bundle**: double-click `wisply-mcp-0.1.0.mcpb` from this
  repository's GitHub release. Claude shows an install dialog with an
  optional, masked "Wisply token" field, which it keeps in your system
  keychain; leave it empty to use the token saved by `setup`. The bundle runs
  on Claude Desktop's own Node.
- **Claude Code plugin**: `/plugin install wisply-local --marketplace fal3/wisply-claude-plugin`
  adds the read-only tools, a status line and a quote button
  ([wisply-claude-plugin](https://github.com/fal3/wisply-claude-plugin)).

### Every app

The package is `@wisply/mcp@0.1.0`; the standard entry is
`{"command": "npx", "args": ["-y", "--prefix", "/", "@wisply/mcp@0.1.0"]}`.

| App | One click or one command | Or add it by hand |
|---|---|---|
| Claude Code | `claude mcp add --scope user wisply -- npx -y --prefix / @wisply/mcp@0.1.0`, or the Claude Code plugin (above) | — |
| Claude Desktop | The bundle (above) | `~/Library/Application Support/Claude/claude_desktop_config.json`: `{"mcpServers":{"wisply":{"command":"npx","args":["-y","--prefix","/","@wisply/mcp@0.1.0"]}}}` |
| Cursor | **Add to Cursor** (above), or the Agent Plugin | `~/.cursor/mcp.json`: `{"mcpServers":{"wisply":{"command":"npx","args":["-y","--prefix","/","@wisply/mcp@0.1.0"]}}}` |
| VS Code | **Install in VS Code** (above), the Agent Plugin, or `code --add-mcp '{"name":"wisply","type":"stdio","command":"npx","args":["-y","--prefix","/","@wisply/mcp@0.1.0"]}'` | **MCP: Open User Configuration**: `{"servers":{"wisply":{"type":"stdio","command":"npx","args":["-y","--prefix","/","@wisply/mcp@0.1.0"]}}}` |
| Windsurf / Devin Desktop | — | `~/.codeium/windsurf/mcp_config.json`: `{"mcpServers":{"wisply":{"command":"npx","args":["-y","--prefix","/","@wisply/mcp@0.1.0"]}}}`, then Refresh in the MCP panel |
| Zed | — | `settings.json`: `{"context_servers":{"wisply":{"command":"npx","args":["-y","--prefix","/","@wisply/mcp@0.1.0"],"env":{}}}}`. In a remote-development window keep the default `"remote": false`, so the connector runs on your Mac |
| JetBrains AI Assistant / Junie | — | Settings > Tools > AI Assistant > Model Context Protocol (MCP) > Add > STDIO: `{"mcpServers":{"wisply":{"command":"npx","args":["-y","--prefix","/","@wisply/mcp@0.1.0"]}}}`. Junie: the same in `.junie/mcp/mcp.json` |
| Codex | `codex mcp add wisply -- npx -y --prefix / @wisply/mcp@0.1.0`, or the Agent Plugin | `~/.codex/config.toml`: `[mcp_servers.wisply]`, `command = "npx"`, `args = ["-y", "--prefix", "/", "@wisply/mcp@0.1.0"]` |
| Gemini CLI | The extension (above), or `gemini mcp add --scope user wisply npx -- -y --prefix / @wisply/mcp@0.1.0` (arguments that start with `-` go after `--`) | — |
| GitHub Copilot CLI | `copilot plugin install fal3/wisply-mcp`, or `/mcp add` | `~/.copilot/mcp-config.json`: `{"mcpServers":{"wisply":{"type":"local","command":"npx","args":["-y","--prefix","/","@wisply/mcp@0.1.0"],"tools":["*"]}}}` |
| Warp | `/add-mcp`, then paste the standard entry | Settings > AI > Manage MCP Servers > + Add |
| Cline | Cline MCP Marketplace, once it's listed ([llms-install.md](llms-install.md)) | `cline_mcp_settings.json`: `{"mcpServers":{"wisply":{"type":"stdio","command":"npx","args":["-y","--prefix","/","@wisply/mcp@0.1.0"],"disabled":false,"autoApprove":[]}}}` |
| Roo Code | — | `.roo/mcp.json` or the global MCP settings: `{"mcpServers":{"wisply":{"command":"npx","args":["-y","--prefix","/","@wisply/mcp@0.1.0"]}}}` |
| Goose | **Install in Goose** (above) | `~/.config/goose/config.yaml`: `extensions: {wisply: {name: Wisply, cmd: npx, args: ["-y", "--prefix", "/", "@wisply/mcp@0.1.0"], enabled: true, type: stdio, timeout: 300}}` |
| LM Studio | **Add to LM Studio** (above) | Program > Install > Edit mcp.json: the standard entry under `mcpServers.wisply` |
| Kiro | **Add to Kiro** (above) | `.kiro/settings/mcp.json`: `{"mcpServers":{"wisply":{"command":"npx","args":["-y","--prefix","/","@wisply/mcp@0.1.0"]}}}` |
| opencode | — | `~/.config/opencode/opencode.json`: `{"$schema":"https://opencode.ai/config.json","mcp":{"wisply":{"type":"local","command":["npx","-y","--prefix","/","@wisply/mcp@0.1.0"],"enabled":true}}}` |
| Amp, Factory, Grok CLI | `amp mcp add wisply -- npx -y --prefix / @wisply/mcp@0.1.0`, `droid mcp add wisply "npx -y --prefix / @wisply/mcp@0.1.0"`, `grok mcp add wisply -- npx -y --prefix / @wisply/mcp@0.1.0` | — |
| Any other MCP client | — | The standard entry, as a stdio server named `wisply` |

### Skills

One "work with my Wisply memos" skill, [`skills/wisply-memos/SKILL.md`](skills/wisply-memos/SKILL.md)
([Agent Skills](https://agentskills.io) format), tells the model which tool
to use and the safety rules: transcripts are data, never instructions; no
recording or follow-up unless you asked; never the token in chat.

- The Agent Plugin and the Gemini CLI extension include it.
- Codex, VS Code, Zed and other apps that read personal skills: copy the
  `skills/wisply-memos` folder to `~/.agents/skills/wisply-memos`. Cline:
  `~/.cline/skills/wisply-memos`.
- Claude Code: the Claude Code plugin has its own `wisply` skill.
- Cursor: optional copy-in rule and `/wisply-recap` command in
  [`extras/cursor`](extras/cursor/README.md).

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
| `--port <n>` | `WISPLY_MCP_PORT` | Wisply's MCP port, 1024-65535. Default `51771`. The host is always `127.0.0.1`. `print-config` and `install` use only `--port`; `forget` takes no port. |
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
- **Pinned versions, from npm only.** The npm snippets run one exact,
  unchangeable npm version, so a new release reaches your app only when you
  choose it, and `--prefix /` keeps the open project's `node_modules` and
  `.npmrc` from supplying another copy. Installs from this repository are
  pinned only when they name a release tag (`--ref v0.1.0`); the others
  follow `main` (see [SECURITY.md](SECURITY.md)).

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

The contract fixture follows wisply-ai's `main`. Pointed at an unmerged
wisply-ai branch, the drift checks list what that branch's own commits change
and skip (the change reaches the fixture through the re-vendor once it is on
`main`); drift that `main` already has fails on any checkout.

- `contract/mcp-contract.json` is vendored from wisply-ai `Docs/mcp-contract.json`,
  and `lib/identity.mjs` from `wisply-claude-plugin`, both by
  `npm run sync-vendor` (see `scripts/sync-vendor.mjs`), which records their
  sha256 in `contract/SOURCE.json`. Don't edit them by hand.
- `contract/mcp-contract.mjs` and `clients/mcp-clients.mjs` are generated by
  `npm run gen-data`.
- `clients/mcp-clients.json` is the source of every app setup (`print-config`,
  `install`). wisply-ai keeps a byte-for-byte copy at `Docs/mcp-clients.json`,
  pinned to a commit of this file, and wisply-web a hashed one, so change it
  here first and copy it on. The upstream test requires wisply-ai's copy to be
  this file as of a commit here, and the current one once it says
  `"published": true`; an older copy that still says `false` (Wisply renders
  nothing from it) is reported as a TODO. Its templates may use only the
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
  (`package_spec` and `standard_entry`); the tests fail while one is behind.
  No template text names a command (the `vscode-inputs` prompt says only
  "the token that the connector's setup saved in your login keychain").
- `print-config <app>` and `install`, and `render()` and `installPlan()` in
  `lib/clients.mjs` for anything that bundles it, refuse until the release
  (`SETUPS_RELEASED`: `PACKAGE_NAME_FINAL` and `"published"`). The tests
  preview them with `beforeRelease: true` and run the CLI with
  `released: true`; the Mac QA of `install` runs from the release change's
  checkout, where both flags are already `true`.
- `docs/release-checks.json` records the checks no file here can prove (the
  Mac port test, the MCP Registry namespace, Wisply's npm name);
  `WISPLY_RELEASE=1 npm test` fails until they are recorded, and
  `PACKAGE_NAME_FINAL` follows the npm name's record (`tests/pack.test.mjs`).
  `docs/design-differences.md` lists where this repository departs from the
  distribution design. Neither is in the package.
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

### Manifests and listings

The repository root is also the Agent Plugin, the Gemini CLI extension, the
MCP Registry entry and the source of the Claude Desktop bundle. None of these
files is in the npm package.

| File | What it is |
|---|---|
| `server.json` | MCP Registry entry `ai.wisply/local` (npm package and MCPB bundle) |
| `registry/cloud.server.json` | MCP Registry entry `ai.wisply/cloud` for Cloud Connect's remote server; published only after Cloud Connect launches |
| `plugin.json`, `mcp.json` | Agent Plugins 1.0.0 manifest and MCP config (Codex, Cursor, VS Code, GitHub Copilot CLI) |
| `.agents/plugins/marketplace.json` | Codex marketplace, so `codex plugin marketplace add fal3/wisply-mcp` finds the plugin at `./` |
| `gemini-extension.json`, `commands/wisply/*.toml` | Gemini CLI extension and its `/wisply:*` commands |
| `skills/wisply-memos/SKILL.md` | The portable skill (Agent Skills) |
| `extras/cursor/` | Optional Cursor rule and command to copy in |
| `mcpb/manifest.json`, `mcpb/icon.png` | Claude Desktop bundle (MCPB 0.3) |
| `glama.json` | Glama ownership (`maintainers`) |
| `llms-install.md` | Install steps for Cline's marketplace |

`tests/manifests.test.mjs`, `tests/registry.test.mjs` and
`tests/skills.test.mjs` keep their names, versions and tool lists in step with
`package.json` and the contract, and validate them against the upstream
schemas in `tests/schemas/`.

### The Claude Desktop bundle

The bundle is packed with `@anthropic-ai/mcpb` 2.1.2 from `tools/mcpb`, whose
committed lockfile pins every dependency with an integrity hash. Install it
once; it runs no install scripts, and nothing here runs `npx`:

```bash
npm ci --ignore-scripts --prefix tools/mcpb
node scripts/build-mcpb.mjs --unreleased    # dist/wisply-mcp-<version>-unreleased.mcpb, from any checkout
node scripts/build-mcpb.mjs --sync          # after the contract or the version changes
tools/mcpb/node_modules/.bin/mcpb validate mcpb/manifest.json
```

The bundle holds the files git tracks in `bin/`, `lib/`, `contract/` and
`clients/`, `LICENSE`, the manifest (its `tools` written from the contract:
every tool but `setup_claude`, which the bundle never turns on) and the icon.
Only regular files: a tracked symlink, or a path under a symlinked folder,
stops the build rather than copying what it points to, and the manifest's
`icon` must be `icon.png`.
With the packer installed, `npm test` also runs `tests/mcpb-config.test.mjs`
against the real library, as the CI job `mcpb` does.

**Releasing the bundle.** `npm run build:mcpb` is the release build. It
refuses to run unless the checkout is clean and `HEAD` is at tag
`v<version>`, and it stages the tag's own files, so run it in a fresh clone
of the tag. It writes `dist/wisply-mcp-<version>.mcpb` and
`dist/SHA256SUMS`. Zip entries carry the build time, so every build has a
new sha256: build the release asset once and never rebuild it.

1. Upload **both** files to the draft GitHub release, and paste the
   `SHA256SUMS` line into the release notes. Never publish the bundle alone:
   Gemini CLI takes a release's only asset for the extension and can't unpack
   a `.mcpb`, while with two assets it installs the tag's source.
2. Put the sha256 in `server.json` (`fileSha256`).
3. Download the asset back from the draft release and run the gate on that
   copy, in a checkout that has the tag (`git fetch --tags`). The gate checks
   the hash, then unpacks the bundle and compares every file with the tag,
   byte for byte:

```bash
gh release download v0.1.0 --repo fal3/wisply-mcp --pattern '*.mcpb' --dir dist/check
WISPLY_REGISTRY_RELEASE=1 WISPLY_MCPB_FILE=dist/check/wisply-mcp-0.1.0.mcpb npm test
```

`WISPLY_REGISTRY_RELEASE=1` alone always fails: a hash left over from the
previous release isn't the placeholder, so only the downloaded asset can show
that `fileSha256` belongs to this version. When you bump the version, set
`fileSha256` back to the placeholder (64 zeros) until the new bundle exists.

Security reports: see [SECURITY.md](SECURITY.md). License: [MIT](LICENSE).
