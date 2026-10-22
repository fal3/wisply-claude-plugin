# Wisply for VS Code

Use your Wisply meeting notes, action items and live transcript in your editor's AI chat, from the Wisply app on this Mac.

- **Wisply in AI chat.** The MCP server **Wisply (this Mac)** gives your editor's AI chat Wisply's tools: list and search your memos, read action items and open questions, and follow the recording in progress.
- **Recording state in the status bar.** See at a glance whether Wisply is recording, for how long, and how many words so far.
- **Wisply: Insert Transcript Quote.** Put the last words of the recording in progress, or an excerpt from any memo, at the cursor.
- **A skill for AI chat.** The bundled "wisply-memos" skill tells the AI how to use Wisply's tools safely: it cites memos, treats recorded speech as quoted data, and never asks for your token in chat.

The extension talks only to the Wisply app on your Mac, at 127.0.0.1, with no account and no cloud service in between. What your AI chat reads from Wisply goes to the AI service your editor uses; see [Privacy](#privacy).

## Requirements

- macOS, with [Wisply for Mac](https://www.wisply.ai) {READ_MIN} or later. The status bar item refreshes more often with Wisply {RECORDING_MIN} or later.
- In Wisply: **Settings > Integrations > MCP Server**, turn on **Enable MCP server on this Mac**.
- VS Code 1.93 or later. The MCP server needs VS Code 1.101 or later; on older versions, and in Cursor and other editors, see [Other editors](#other-editors).

On Windows and Linux the extension installs, but there's no Wisply to connect to: it never asks for a token there and shows no status bar item.

## Get started

1. In Wisply, open **Settings > Integrations > MCP Server** and copy the **read-only connector token** (it starts with `wspc_`).
2. In VS Code, run **Wisply: Set Token…** from the Command Palette and paste it. The token goes into the editor's secret storage.
3. Open the chat, make sure the **Wisply (this Mac)** tools are on, and ask: "List my latest Wisply memos." If VS Code asks whether you trust the server, or the workspace in Restricted Mode, confirm.

Use the read-only connector token unless you need more. A full-access token (`wsp_`) also lets AI chat start and stop recordings (if you allow it in Wisply) and propose follow-ups, so the extension asks you to confirm it. A recording-control token (`wspr_`) can't read memos, so the extension refuses it.

If you start the server before you set a token, VS Code asks for one. If you cancel, the server uses the token saved in the Mac Keychain (see [Other editors](#other-editors)), with the read-only memo tools only.

## The status bar item

| Icon and text | Meaning |
|---|---|
| Record icon, "Wisply 12:04", highlighted | Wisply is recording. The tooltip shows the word and speaker counts. |
| Pause icon, "Wisply 12:04" | The recording is paused. |
| Microphone icon, "Wisply" | Wisply is running and not recording. |
| Key icon, "Wisply" | No token is set, or Wisply isn't set up in this editor yet. Run **Wisply: Set Token…** (in Cursor, **Store Token in the Mac Keychain…** and then **Check Connection**). |
| Unplugged icon, "Wisply" | Wisply isn't answering. Open Wisply and turn on its MCP server. |
| Warning icon, "Wisply" | Something else is wrong; the tooltip says what. |

Click the item for the Wisply menu: Insert Transcript Quote, Check Connection, Set Token…, Store Token in the Mac Keychain…, Open Setup Guide and Hide Status Item.

The extension asks Wisply for its state only once Wisply is set up in this editor: a token set with **Wisply: Set Token…**, or a **Check Connection** or **Insert Transcript Quote** that reached Wisply. Until then the item is a key icon that opens the menu, and the extension doesn't contact Wisply or read the Mac Keychain. After that it asks only while the editor window is focused: every 10 seconds during a recording, every 30 seconds otherwise, and every 60 seconds while Wisply isn't answering. After three answers in a row without a recording state (no token, Wisply not answering, another problem), it stops asking until the window gets focus again, you set a token, or **Check Connection** or **Insert Transcript Quote** reaches Wisply. **Forget Token** returns the item to the key icon. Each check reads the recording's state, length and word and speaker counts. Wisply sends the last word of the transcript with them (versions before {RECORDING_MIN} send the whole transcript, so the extension checks those only once a minute); the extension drops it, and the item never shows what was said. To turn the item and its checks off, choose **Hide Status Item**, or turn off `wisply.statusBar.enabled`. (Hiding it from the status bar's own right-click menu only hides it; the checks go on.)

## Insert Transcript Quote

Run **Wisply: Insert Transcript Quote** with the cursor where the quote should go.

- **While Wisply is recording,** it inserts the last 80 words of the live transcript (`wisply.quote.words`, 10 to 400).
- **Otherwise,** it asks what to search for, lists the memos that mention it (title, date and excerpt), and inserts the excerpt you choose.

A quote looks like this (`wisply.quote.format`):

```markdown
> …we agreed the budget stays flat for Q3
>
> — Wisply recording (quoted speech), "Q3 planning", 2026-10-20
```

or, with `plain`: `"…we agreed the budget stays flat for Q3" (Wisply recording, quoted speech, Q3 planning, 2026-10-20)`. Each insert is a single edit, so one Undo removes it.

What was said, and a memo's title, are quoted as text. In a Markdown quote, links, images, HTML and other Markdown in them are escaped, so they show exactly as typed and a Markdown preview or GitHub doesn't turn them into links, images or formatting. A plain quote breaks up link and HTML syntax with a space. A web address that someone said stays visible as said. The attribution says the text is quoted speech from a Wisply recording, so an AI agent that later reads the file can tell it apart from your own notes. Agents can still be fooled by what they read, so don't ask one to act on a quote it hasn't shown you.

## Commands

| Command | What it does |
|---|---|
| Wisply: Set Token… | Stores the token in the editor's secret storage. |
| Wisply: Forget Token | Removes it again. |
| Wisply: Insert Transcript Quote | Puts a quote at the cursor (above). |
| Wisply: Check Connection | Checks that Wisply answers and proves its identity, and says how many tools your token reaches. |
| Wisply: Store Token in the Mac Keychain… | Opens a terminal where macOS asks for the token and keeps it in your login keychain, for Cursor, other editors and other apps on this Mac. |
| Wisply: Open Setup Guide | Opens the setup guide on wisply.ai. |

When you set, replace or forget the token (in any window), the server definition changes, and VS Code restarts **Wisply (this Mac)** or offers to: a running server keeps the old token until then. The token you enter when the server first starts is the exception: that start already uses it.

## Settings

Wisply reads its settings only from your **user** settings on this computer. A repository can't change them: not with `.vscode/settings.json`, trusted or not, and not with a dev container's `devcontainer.json` or a remote machine's settings, because they are `application` settings, which VS Code never reads from remote settings.

| Setting | Default | |
|---|---|---|
| `wisply.statusBar.enabled` | `true` | Show the status bar item. |
| `wisply.quote.words` | `80` | Words Insert Transcript Quote takes from the recording in progress (10 to 400). |
| `wisply.quote.format` | `markdown` | `markdown` or `plain`. |
| `wisply.port` | `51771` | Wisply's MCP port, if you changed it in Wisply. Settings Sync doesn't copy it. |
| `wisply.mcp.allowClaudeSetup` | `false` | Offer Wisply's `setup_claude` tool to AI chat with a full-access token set with **Wisply: Set Token…**. It can replace the Anthropic API key saved in Wisply, so leave it off unless you need it. Settings Sync doesn't copy it, so turning it on for one Mac leaves it off everywhere else. |

## Other editors

The extension is also on [Open VSX](https://open-vsx.org), for Cursor, Windsurf, Kiro, VSCodium and other editors built on VS Code.

- **Cursor:** the extension adds Wisply to Cursor's MCP servers itself. That server reads the token from the Mac Keychain, so run **Wisply: Store Token in the Mac Keychain…** once.
- **Editors without either MCP API:** a one-time notice offers **Copy Config**, an entry to paste into the editor's MCP settings. It contains no token and also reads the Keychain. It runs the connector inside this extension, whose folder changes when the extension updates, so copy the entry again after an update.
- **A token from the Mac Keychain gets the read-only memo tools only:** list and search memos, the live transcript and action items, nothing that starts a recording or proposes a follow-up. The extension never confirmed that token, and another app's setup may have saved a full-access one there. Recording control, follow-ups and `setup_claude` need a token set with **Wisply: Set Token…** in VS Code 1.101 or later.
- The status bar item and Insert Transcript Quote work in every editor.
- In a Remote-SSH or dev container window, the extension still runs on your Mac, where Wisply is.

## Privacy

- Wisply's connector talks only to the Wisply app on this Mac, at 127.0.0.1. Before it sends your token, Wisply has to prove it holds the same token (an HMAC over a fresh random value). Nothing else is contacted, and the extension collects no analytics.
- When your editor's AI chat reads a memo, the editor sends what it read to the AI service it uses, under that service's terms. Only what the chat asks for is read.
- The status bar item and Insert Transcript Quote read Wisply on your Mac only. A quote goes into your file, and nowhere else, until you share that file.
- The extension stores your token in VS Code's secret storage and keeps no logs of your memos. Wisply's connector logs nothing about your memos either. Your editor's own MCP log (**MCP: Show Output**) can record tool results, memo text included, if you raise its log level to Debug or Trace.
- The server the editor starts gets its token and port from the extension only. `WISPLY_MCP_TOKEN`, `WISPLY_MCP_ALLOW_CLAUDE_SETUP`, `WISPLY_MCP_DEBUG` and `NODE_OPTIONS` set in your shell for another app are removed from its environment.
- **Store Token in the Mac Keychain…** keeps the token in your login keychain, out of config files, Settings Sync and dotfile repositories. It refuses the full-access token. If you store a recording-control token (`wspr_`), it says so: every other AI app on this Mac that reads the item without a token of its own can then start and stop recordings while Wisply allows agents to; this editor still gets only the read-only memo tools from the Keychain. macOS backs up the login keychain with your other files (Time Machine, for example), encrypted with your login password. Other programs running as you on this Mac can still read the item, so use the read-only connector token, and regenerate it in Wisply if you suspect malware. The setup terminal starts with a fixed, minimal environment, so nothing that another extension or your terminal settings add (such as `NODE_OPTIONS`) runs inside it.
- **Forget Token** removes the token from the editor's secret storage. A token in the Mac Keychain stays there until you delete "Wisply MCP token" in Keychain Access. To revoke the token everywhere, regenerate it in Wisply.

## Why this extension starts a process and reads the Keychain

Store reviewers and careful users will see the extension start a Node process and call `/usr/bin/security`. This is what they do and why.

- **The bundled connector.** `server/wisply-mcp.mjs` is a single-file build of [`fal3/wisply-mcp`](https://github.com/fal3/wisply-mcp), Wisply's MIT-licensed MCP connector. The editor runs it with its own built-in Node: the editor's executable with `ELECTRON_RUN_AS_NODE=1`, the standard way to run a Node script with an Electron app. Nothing is downloaded and `npx` is never used.
- **It runs in two ways.** As the MCP server **Wisply (this Mac)** when your AI chat starts it, and as a small read-only helper that the extension starts for its own reads: the status bar item, Insert Transcript Quote and Check Connection. The helper is started with `--read-only`, so it can't start or stop a recording whatever the token. It starts only when you run one of those commands, or for the status bar item once Wisply is set up in this editor. While the item is on and the window is focused, the item asks at least once a minute, so the helper keeps running; it stops two minutes after its last use, for example once the window loses focus.
- **Why a separate process.** The editor routes network requests made from extension code through its proxy settings. The token must only ever go to 127.0.0.1, so it is sent only from these plain Node processes, never from the extension itself. They also run Wisply's identity check before every use of the token.
- **The Keychain.** When the editor's secret storage holds no token, the connector reads the login keychain item "Wisply MCP token" (service `ai.wisply.mcp`, account `token`) through `/usr/bin/security`, by absolute path and with fixed arguments, and offers only the read-only memo tools with it. The helper reads it when it starts and keeps a usable token for as long as it runs; while there is none, each status check reads the item again, and after three such checks in a row the status bar item stops asking until the window gets focus again. Before Wisply is set up in the editor, nothing reads it. Only **Wisply: Store Token in the Mac Keychain…** writes that item, in a terminal where macOS's own `security` tool asks you for the token, so the token never passes through the extension.
- **The editor's texts.** One file in the bundle isn't from the connector's repository: `src/editor-messages.mjs` replaces the connector's texts that tell you what to run (no token, a malformed token, a failed identity check, Wisply's Keychain answer, and the setup terminal's lines). In an editor they point to **Wisply: Set Token…**, **Wisply: Store Token in the Mac Keychain…** and Keychain Access instead of shell commands that don't exist there. The AI model in chat reads these texts too, so none of them names a package or a command it could run.
- **Source.** `vendor/SOURCE.json` in the package lists the source commits and sha256 of every bundled file, the skill included. The extension's own code is in [`fal3/wisply-vscode`](https://github.com/fal3/wisply-vscode).

## Troubleshooting

- **Key icon, or "Wisply token is not set":** run **Wisply: Set Token…**, or in Cursor **Wisply: Store Token in the Mac Keychain…** and then **Wisply: Check Connection**.
- **Unplugged icon, or "Wisply isn't answering":** open Wisply and turn on **Settings > Integrations > MCP Server**. If you changed Wisply's port, set `wisply.port` to match.
- **"Wisply identity check failed":** the program on Wisply's port couldn't prove it is the Wisply that issued your token, so the token wasn't sent. If you regenerated the token in Wisply, set it again. Otherwise quit whatever is using that port.
- **Wisply couldn't read its tokens from the Keychain:** quit and reopen Wisply. Any program on the port can send that answer, so if macOS then asks for Keychain access, allow it only when the dialog names Wisply.
- **New token, same tools:** restart **Wisply (this Mac)** from **MCP: List Servers**.
- **Turning off the MCP server in Wisply:** Wisply stops answering MCP requests at once; if Wisply Companion is set up, the same local listener stays on for it.

## Security

See [SECURITY.md](SECURITY.md) for what the extension protects, what it doesn't, and how to report a problem. Changes are in [CHANGELOG.md](CHANGELOG.md).

## License

MIT. See [LICENSE](LICENSE).
