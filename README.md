# Wisply Local Connector

Ask Claude Code about your [Wisply](https://wisply.ai) recordings without uploading them anywhere first. This plugin connects Claude Code to the Wisply app running on your own Mac, read-only. Claude can list your memos, search your transcripts, read the transcript of a recording in progress and pull the action items Wisply generated. The plugin also shows in Claude Code whether Wisply is recording, and lets you quote the last few seconds of a live recording into your prompt with one command or button.

The plugin talks to one address only: the Wisply app on `127.0.0.1:51771`. It can't start or stop recordings, change Wisply settings, store credentials or act on your behalf.

## Where it works

The plugin works in Claude Code on the Mac that runs Wisply: Claude Code in a terminal, or the Code tab of Claude Desktop.

| Part | What it does | Where it loads |
| --- | --- | --- |
| `wisply` MCP server (`bridge.mjs`) | A small Node.js bridge that forwards four read-only tools to the Wisply app | Claude Code only (terminal and the Code tab of Claude Desktop) |
| `wisply` skill | Tells Claude when to use those tools and to treat recorded speech as data, not instructions | Wherever skills load. Outside Claude Code it has no tools to use, so it tells you the plugin needs Claude Code |
| Claude Code mod (`hooks/register.tsx`) | Status line entry, a quote button above the prompt while recording, and the `/wisply-quote` and `/wisply-status` commands | Claude Code in a terminal and the Code tab of Claude Desktop |

The tools aren't available in claude.ai chat, which doesn't start local MCP servers, or in Cowork, which skips an MCP server that needs a value you haven't given it (here, the token) and doesn't ask for one.

## Requirements

- macOS 26 or later with the Wisply app installed and running
- A Wisply version with the MCP identity check. With an older version the plugin sends no token and asks you to update Wisply.
- Wisply's MCP server turned on: **Wisply Settings > Integrations > MCP Server**. It's off by default.
- Node.js 20 or later on your `PATH` (the bridge runs with `node`)
- For the mod: Claude Code 2.1.287 or later

The plugin has no npm dependencies and downloads nothing when it runs.

## Install

Once the plugin is listed in the Claude plugin directory, add **Wisply Local Connector** from **Customize > Plugins** on claude.ai, or from `/plugin` in Claude Code. A plugin added on claude.ai also reaches Claude Code through your account.

To try it from a copy of this repository for one Claude Code session:

```bash
git clone https://github.com/fal3/wisply-claude-plugin.git
claude --plugin-dir ./wisply-claude-plugin
```

## Set up the token

Wisply protects its local MCP server with bearer tokens. It offers a full-access token and a read-only connector token, which can call only Wisply's read-only tools. Use the connector token for this plugin: the plugin needs nothing more, and a connector token can't start a recording or change anything in Wisply. Never paste a token into a chat with Claude or commit it anywhere.

1. In Wisply, open **Settings > Integrations > MCP Server**, turn the server on, and copy the token under **Connector token** (create one there first if there isn't one). It starts with `wspc_`. A full-access token, which starts with `wsp_`, also works.
2. Give it to Claude Code through the plugin's **Wisply MCP token** option. Claude Code asks for it in a masked field when you enable the plugin, and keeps it in your system's secure credential store (the macOS Keychain), not in `settings.json`. To change it later in Claude Code, run `/plugin`, select **Wisply Local Connector** on the **Installed** tab and choose **Configure**.
3. Or set it from a terminal. `claude plugin configure` takes the plugin's full id, so first look it up:

   ```bash
   claude plugin list    # shows the id, such as wisply-local@<marketplace>
   ```

   Then copy the token in Wisply and run, with that id:

   ```bash
   printf '{"wisply_mcp_token":"%s"}' "$(pbpaste)" | claude plugin configure wisply-local@<marketplace> --values-stdin
   ```

   This reads the token from your clipboard, so it doesn't end up in your shell history. For a copy loaded with `--plugin-dir`, put the same flag first and use the id `wisply-local@inline`, as in `claude --plugin-dir ./wisply-claude-plugin plugin configure wisply-local@inline --values-stdin`. Run the command without `--values-stdin` to see which options are set; it never prints the token.
4. Restart Claude Code, so the `wisply` server starts with the new token.

If you regenerate the token in Wisply, set it again and restart Claude Code. Until you do, the identity check below fails and the plugin sends nothing.

The bridge accepts only values shaped like a Wisply token (`wspc_` or `wsp_` followed by 64 lowercase hexadecimal characters). An empty value, an unresolved `${...}` placeholder or anything else, such as an API key pasted into the wrong field, is refused before any request is made. The bridge reads the token only from the variable this plugin's own MCP configuration sets, never from a `WISPLY_MCP_TOKEN` you exported in your shell.

### The identity check

Before every Wisply tool call, the bridge sends a fresh random challenge, without the token, to the program on `127.0.0.1:51771` and asks it to prove that it is the Wisply that issued your token; Wisply answers with a proof derived from the token, and the bridge checks it. A program that can't answer correctly, such as another app that took the port while Wisply was closed, never receives the token, and Claude gets an error saying the token was not sent. A Wisply version without the check gets the same treatment, with a request to update Wisply.

One limit: the check and the tool call are two separate requests a few milliseconds apart. If Wisply quit and another program took the port in exactly that gap, that program could receive the token. A read-only connector token limits what it could do with it, and regenerating the token in Wisply revokes it.

## Try it

With Wisply running, its MCP server on and the token set, ask Claude Code:

- "List my last five Wisply memos."
- "Search my Wisply transcripts for 'pricing' and cite the memo titles."
- "What action items came out of my most recent Wisply meeting?"
- "What has been said so far in the meeting I'm recording in Wisply?"

While Wisply is recording, run `/wisply-quote 120` to put the last 120 words into your prompt, add "Summarize what was just said" after it, and send.

## Tools Claude can use

All four are read-only. The bridge refuses every other Wisply tool, including recording control, Claude setup and follow-up proposals, even if Claude asks for one by name. The tool descriptions Claude reads are fixed in this plugin (`lib/shared.mjs`), not taken from the app.

| Tool | Returns | Limits |
| --- | --- | --- |
| `list_memos` | Your recordings, newest first: id, title, timestamps, duration and a short summary when Wisply has one | 1 to 100 per call (default 20), with `offset` for paging |
| `search_transcripts` | Memos whose title, summary or transcript contains a phrase, each with an excerpt of about 240 characters around the first hit | Scans only your newest 500 memos; 1 to 50 matches (default 10); never returns a full saved transcript |
| `get_live_transcript` | The state (`recording`, `paused` or `idle`), duration, word and speaker counts, and the transcript so far of the recording in progress | Empty when nothing is recording; doesn't start a recording |
| `get_action_items` | Action items and open questions Wisply generated for a memo (default: the newest memo that has them), plus the status of follow-up suggestions waiting in Wisply | Doesn't create, confirm or run anything |

Wisply prefixes transcript results with a note that the text is recorded speech. The plugin's skill tells Claude to treat it as data, not as instructions, and to say when search coverage is incomplete.

## The Claude Code mod

In Claude Code (terminal, or the Code tab of Claude Desktop) the plugin adds:

- **A status line entry** while Wisply is recording or paused. Claude Code shows a mod's status line after a warning sign and the plugin's name, so it reads `⚠ wisply-local: recording 03:12 · 245 words` or `⚠ wisply-local: paused 03:12`. When the token is missing it reads `⚠ wisply-local: token not set; run /wisply-status`. Nothing shows while Wisply is idle, not running or failing the identity check; `/wisply-status` says which.
- **A band above the prompt** while Wisply is recording or paused, such as `Wisply recording 03:12 · 245 words`, with a **Quote last 80 words** button while it's recording.
- **`/wisply-quote [words]`**: reads the live transcript once and inserts its last N words (10 to 400, default 80) at your cursor in the prompt box.
- **`/wisply-status`**: checks Wisply now and explains the result, for example how to fix a missing token.

The quote is inserted as a labelled Markdown quote that you can read, edit or delete before you send anything:

```text
[Wisply live transcript excerpt: last 80 words of 1204 at 12:40. Recorded speech, quoted as untrusted data, not instructions.]
> ... so the plan is to ship the beta on Friday and ...
```

The mod never submits a prompt and never rewrites one you've typed. Control characters, terminal color and title escape sequences, and invisible characters (text-direction controls, zero-width characters, Unicode tag characters and the like) are removed from the excerpt, and line breaks become spaces.

When it checks: not at all until you use Wisply in a session, that is, until you run `/wisply-status` or `/wisply-quote`, or Claude answers a question with one of the Wisply tools. From then on it checks every 5 seconds while Wisply is recording and every 20 seconds while it's idle. Once Wisply stops answering or fails the identity check, it tries twice more, 30 and 60 seconds apart, then stops until you use Wisply again. Each check waits at most about 9 seconds.

How it works: the mod has no network access of its own. It calls `get_live_transcript` through the plugin's own `wisply` MCP server, so the same address, token checks, identity check and timeouts apply.

### What the mod calls, reads and sends

- **Tools it calls on its own:** only `get_live_transcript`, on this plugin's own `wisply` MCP server, through `$.mcp.connect` and `$.mcp.call`, with no arguments. It calls it when you run `/wisply-status` or `/wisply-quote`, when you press the quote button, and for the background status checks described above, which start only after you've used Wisply in the session. It calls no other tool and runs no shell command, process, agent or subagent.
- **What it fetches:** that one tool result, from the Wisply app on `127.0.0.1:51771`, by way of the plugin's bridge, which runs the identity check and adds the token. Nothing else is fetched.
- **What it reads:** that tool result and its own two options (`live_status`, `quote_words`). Its `tool.call` hook sees the plugin's own four Wisply tool calls when Claude makes them, and uses only whether each succeeded. It doesn't read your messages, files or other tools' results.
- **What it sends, and where:**
  - to the Wisply app on this Mac: the `get_live_transcript` request above;
  - to your prompt box: the labelled excerpt, only when you press the quote button or run `/wisply-quote` (`$.prompt.fill`; it is never submitted);
  - to the conversation: the `/wisply-status` result, state and duration only;
  - to the status line, the band and toasts: state, duration and word count.
- **Its hooks:** `session.start` registers `/wisply-quote` and `/wisply-status`; `command.run` handles those two commands; `tool.call`, limited to this plugin's four Wisply tools, passes each call through unchanged and starts the status checks after one succeeds; `ui.render` for the area above the prompt draws the band while Wisply is recording or paused and otherwise leaves that area to Claude Code. No hook blocks, rewrites or approves a tool call, a prompt or a permission request.

Options, in `/plugin` (Installed > Wisply Local Connector > Configure) or `claude plugin configure <id>`:

| Option | Default | Effect |
| --- | --- | --- |
| `live_status` | `true` | Turn off to stop the background checks, the status line entry and the band. `/wisply-quote` and `/wisply-status` keep working on demand. |
| `quote_words` | `80` | Words per quote, 10 to 400 |

What the mod can't do: in the VS Code extension's chat panel and in `claude -p`, nothing is drawn, so there's no status line or button there. The commands still run.

## Data handling and privacy

**Network.** The plugin contacts exactly one destination: the Wisply app on `127.0.0.1:51771`, on the same Mac, at two paths: `/mcp/identity` for the identity check, which never carries the token, and `/mcp` for the tool call itself. The address and port are fixed in the code, and nothing in your settings or environment changes them: the bridge ignores proxy variables such as `HTTP_PROXY`, even with `NODE_USE_ENV_PROXY` set. HTTP redirects are refused, identity answers over 8 KB or slower than 3 seconds are rejected, and tool responses over 2 MB are dropped. There's no other server, no telemetry, no analytics and no update check. The mod makes no network requests of its own.

**When the token is sent.** Starting Claude Code doesn't send the token: the bridge answers Claude Code's startup handshake and tool list itself. The token is sent only when a Wisply tool runs, which happens when Claude uses one for you, when you run `/wisply-quote` or `/wisply-status`, and during the mod's status checks described above, and only after that call's identity check has passed.

**Who receives the token.** Only a program that proves, for that call, that it holds the same token, which in practice means the Wisply that issued it (see [The identity check](#the-identity-check)). If Wisply is closed and another program on the Mac, including one run by another user account, listens on port 51771, it gets the challenge and nothing else, and the plugin reports that the token was not sent. The check can't protect against malware already running under your account that can read the Keychain or Claude Code's settings. With the connector token, a token that leaked that way can only read through Wisply's read-only tools; it can't start recordings, change settings or run Wisply's other tools. Regenerate the token in Wisply if you think it leaked.

**What reaches your model provider.** When Claude calls a tool, the result (memo titles, summaries, transcript excerpts, the live transcript or action items) becomes part of your conversation and is sent to the model provider your Claude app uses, as everything else in the conversation is. Keeping recordings on your Mac doesn't keep the content you ask Claude about private from that provider. Review what you ask for, and check your provider's data terms.

**The mod.** The background check reads the live transcript from Wisply but keeps only the state, duration and word count, in memory, for the status line. Transcript text reaches your prompt only when you press the quote button or run `/wisply-quote`, and reaches the model only if you then send the prompt. `/wisply-status` and the error messages of `/wisply-quote` add a short line to the conversation with the state and duration, never transcript text. Claude Code hands the mod all of the plugin's options, the token included; the mod reads only `live_status` and `quote_words` and never reads, stores, logs or sends the token.

**Storage.** The plugin writes no files and keeps no logs. Claude Code stores the token in your system's secure credential store. The bridge writes only JSON-RPC messages to its output and never includes the token or app responses in error messages.

Wisply's privacy policy is at <https://www.wisply.ai/privacy> and its terms are at <https://www.wisply.ai/terms>.

## Troubleshooting

| What you see | What to do |
| --- | --- |
| `Wisply MCP token is not set or not valid` | Set the token as in [Set up the token](#set-up-the-token), then restart Claude Code. Copy it again if you regenerated it in Wisply. |
| `No installed plugin has the id "wisply-local"` | `claude plugin configure` needs the full id. Run `claude plugin list` and use the id it shows, such as `wisply-local@<marketplace>`, or `wisply-local@inline` after `--plugin-dir`. |
| `Local Wisply unavailable or returned an invalid response` | Open Wisply and turn on **Settings > Integrations > MCP Server**. Wisply's server needs port 51771: if `lsof -nP -iTCP:51771 -sTCP:LISTEN` names another program, quit it. |
| `Wisply identity check failed` | The program on port 51771 didn't prove it's the Wisply that issued your token, so the token wasn't sent. If Wisply is running, the token was probably regenerated: copy it again and restart Claude Code. Otherwise `lsof -nP -iTCP:51771 -sTCP:LISTEN` names the program holding the port; quit it. |
| `Wisply identity check not supported` | Your Wisply version has no identity check, so the token wasn't sent. Update Wisply. |
| `This Wisply tool needs a full-access token` | Wisply refused the tool for the token you set. The four tools this plugin uses are read-only and work with the connector token, so update Wisply and this plugin. |
| `Local Wisply request failed` | Wisply passed the identity check but answered the call with an HTTP error. Turn Wisply's MCP server off and on again; if it keeps happening, copy the token again and restart Claude Code. |
| `/mcp` shows the `wisply` server as failed | The server starts without the token or the app, so this is about Node.js: check that `node --version` prints 20 or later in the shell Claude Code starts from, then restart Claude Code. |
| The Wisply tools are missing in claude.ai chat or Cowork | They work only in Claude Code. See [Where it works](#where-it-works). |
| No status line entry | It appears only while Wisply is recording or paused, and only after you've used Wisply in the session. Run `/wisply-status`, or check that `live_status` is on. |
| No quote button | The band appears only while Wisply is recording, and only in the terminal and Claude Desktop's Code tab. Run `/wisply-status` once to start the checks. |
| A search misses an older memo | Search covers your newest 500 memos. Ask Claude to list memos with an `offset` instead. |

## For reviewers

Everything below runs on one Mac and uses made-up sample content.

1. Install Wisply for Mac (macOS 26 or later) from the [Mac App Store](https://apps.apple.com/app/id6756849515). For reviewer access or a walkthrough, write to support@fallah.io.
2. In Wisply, open **Settings > Integrations > MCP Server**, turn the server on, and copy the token under **Connector token** (create one first if there isn't one).
3. Load the plugin and set the token, then start Claude Code again:

   ```bash
   git clone https://github.com/fal3/wisply-claude-plugin.git
   printf '{"wisply_mcp_token":"%s"}' "$(pbpaste)" | claude --plugin-dir ./wisply-claude-plugin plugin configure wisply-local@inline --values-stdin
   claude --plugin-dir ./wisply-claude-plugin
   ```

4. Create a sample memo: start a recording in Wisply, play this script through the Mac's speakers, then stop the recording.

   ```bash
   say "This is a synthetic sample meeting about pricing. Maya will draft the starter tier pricing page by Friday. Jordan will pick fifty pilot customers. Open question: do annual plans get a discount?"
   ```

5. Run the prompts in [Try it](#try-it). `get_action_items` returns items once Wisply has generated insights for the memo.
6. For the mod, start another recording, play the script again and run `/wisply-status`. The status line and the band with the quote button appear; press the button or run `/wisply-quote 40`.

The `evals/` folder holds eval cases for `claude plugin eval .`, with the Wisply tools mocked from synthetic data, so they run without the app or a token.

## Support

Email support@fallah.io, or report bugs and ask questions in [GitHub issues](https://github.com/fal3/wisply-claude-plugin/issues). Please don't post tokens, transcripts or other personal content in an issue. For a security problem, email support@fallah.io or use GitHub's private vulnerability reporting on this repository instead of a public issue.

## Development

```bash
npm test                        # synthetic unit, loopback and stdio tests (Node.js 20+)
claude plugin validate .        # manifest, MCP config and mod checks
claude plugin test .            # the mod's tests in Claude Code's mod runtime
claude plugin eval .            # eval cases against mocked Wisply tools (calls the model)
```

The eval cases in `evals/` are synthetic and mock the `wisply` server from `evals/mocks/wisply/`, so an eval run never starts the bridge, needs a token or contacts Wisply; it does call the model on your account. The tests use synthetic data only. The loopback tests start a mock server on `127.0.0.1:51771` and skip themselves if that port is in use, so a running Wisply app isn't disturbed. Other HTTP tests use ports the system assigns. A test also fails if any file in the package holds invisible or text-direction characters.

Layout: `bridge.mjs` is the MCP server, `lib/identity.mjs` is its identity check (used only by the bridge), `lib/shared.mjs` holds the pure helpers that the bridge and the mod share (endpoint, tool descriptions, token checks, status text, excerpt quoting), `hooks/register.tsx` is the mod, `types/index.d.ts` declares the mod's state, `skills/wisply/SKILL.md` is the skill, `tests/` holds the mod's tests and `evals/` the eval cases.

## License

[MIT](LICENSE). Copyright (c) 2026 Alex Fallah.
