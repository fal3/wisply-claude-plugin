# Wisply MCP connector (`@wisply/mcp`)

Use your Wisply meeting notes, action items and live transcript in any MCP
client (Cursor, VS Code, Claude, Codex, Gemini CLI, Zed and others) on the
Mac that runs [Wisply](https://www.wisply.ai). The connector is a small stdio
MCP server. It talks only to the Wisply app at `127.0.0.1`, checks that it is
talking to Wisply before it uses your token, and needs no account.

> **Status: not released yet.** This package isn't on npm, and the name
> `@wisply/mcp` is a placeholder until it is. Its contract with the Wisply app
> is provisional (transcribed from the app's tool catalog), so it can't be
> published (`WISPLY_RELEASE=1 npm test` refuses it). The `setup`, `status`
> and `forget` commands, which keep the token in your login keychain, land
> before the first release. Until then the token comes from
> `WISPLY_MCP_TOKEN` only.

## What you need

- Wisply for Mac with **Settings > Integrations > MCP Server > Enable MCP
  server on this Mac** turned on.
- Node.js 20 or later (tested on 22 and 24).
- A Wisply token. Use the **read-only connector token** (`wspc_...`) unless you
  need recording control.

## Add it to your AI app

Every client runs the same token-free entry:

```json
{ "command": "npx", "args": ["-y", "@wisply/mcp@0"] }
```

For example, in `~/.cursor/mcp.json`:

```json
{ "mcpServers": { "wisply": { "command": "npx", "args": ["-y", "@wisply/mcp@0"] } } }
```

or in Claude Code: `claude mcp add --scope user wisply -- npx -y @wisply/mcp@0`.

Install Wisply once per app. Two entries named `wisply` show the tools twice.
One-click links and snippets for every client follow with the first release
and on [wisply.ai/docs/mcp/install](https://www.wisply.ai/docs/mcp/install).

**Don't paste a token into a config file.** Config files end up in Settings
Sync, dotfile repositories and backups. Let the app's own secret storage set
`WISPLY_MCP_TOKEN` (Wisply's VS Code extension, Claude Desktop bundle and
Gemini CLI extension, which come with the first release, work this way), or,
from the first release, run `npx -y @wisply/mcp setup` once to keep it in your
login keychain.

Three notes:

- **GUI apps and `npx`.** Apps started from the Dock may not see a Node
  installed through nvm. Install Node from nodejs.org or Homebrew; or run
  `npm i -g @wisply/mcp` and use `"command": "wisply-mcp"`; or use the Claude
  Desktop bundle or the VS Code extension, which bring their own Node.
- **Remote windows.** In a VS Code Remote-SSH or Dev Container window, add
  Wisply to your **local** user configuration. A server started on the remote
  machine can't reach Wisply on your Mac.
- **Versions.** `@wisply/mcp@0` runs the newest 0.x release from npm each time
  your app starts the connector. To stay on one exact version, write
  `@wisply/mcp@0.1.0` instead.

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
| | `WISPLY_MCP_TOKEN` | The Wisply token. Empty, or an unresolved `${...}` placeholder, counts as unset. |
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
  token sent, as a bearer header.
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
  Settings > Integrations > MCP Server and give it to your app (see above).
- **"Wisply isn't answering on 127.0.0.1:51771"**: open Wisply and turn on the
  MCP server.
- **"Wisply identity check failed"**: the program on the port couldn't prove
  it holds your token, so the token wasn't sent. If you regenerated the token
  in Wisply, update it in your app. Otherwise quit whatever uses that port.
- **"This version of Wisply has no identity check"**: update Wisply.
- **"... isn't available with your ... token"**: the tool needs another token.

On other platforms the connector explains that it needs Wisply for Mac on the
same computer.

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
- `contract/mcp-contract.mjs` is generated by `npm run gen-data`.
- `tests/fixtures/fake-wisply.mjs` is a synthetic Wisply for local runs:
  `node tests/fixtures/fake-wisply.mjs` prints its port and synthetic tokens.

Security reports: see [SECURITY.md](SECURITY.md). License: [MIT](LICENSE).
