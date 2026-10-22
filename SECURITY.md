# Security

## Reporting a problem

Please report security problems privately: use **Report a vulnerability** on this repository's Security tab (GitHub private vulnerability reporting), or email support@wisply.ai with "security" in the subject. Don't open a public issue. Include the extension version, the editor and its version (Help > About), and steps to reproduce. Never include a real Wisply token.

Only the newest release gets fixes.

## What the extension protects, and what it doesn't

**Tokens and scopes.** Wisply issues three loopback tokens:

- `wspc_`: the read-only connector token (memos, search, live transcript, action items). Use this one.
- `wsp_`: full access. AI chat can also start and stop recordings (only with Wisply's own "Allow agents to start and stop recordings" switch) and propose follow-ups (only proposals: Wisply asks you to confirm). **Wisply: Set Token…** asks for a second confirmation before it stores one.
- `wspr_`: recording control only. It can't read memos, so the extension refuses it.

`setup_claude`, which can store an Anthropic API key in Wisply, stays hidden from AI chat unless you turn on `wisply.mcp.allowClaudeSetup`. Leave it off: Wisply's answer to `setup_claude` currently includes a snippet with Wisply's full-access token, and the connector passes results on unchanged, so the AI chat would send the token to its AI service.

**Where the token lives.** In the editor's secret storage (`SecretStorage`, key `wisply.mcpToken`). It leaves the extension in exactly two ways, both as `WISPLY_MCP_TOKEN` in the environment of a process on this Mac:

- the MCP server the editor starts: the server definitions the extension lists never contain it, and it is added only in the step that runs when the server starts;
- the read-only helper process the extension starts for the status bar item, Insert Transcript Quote and Check Connection. It runs with `--read-only` and an environment of its own (the token, the port, `HOME` and `PATH`, nothing else from the editor). It starts when you run one of those commands, or for the status bar item once Wisply is set up in this editor (a token in secret storage, or a Check Connection or quote that reached Wisply). While the item is on and the window is focused it keeps running, since the item asks at least once a minute; it stops two minutes after its last use.

Cursor's MCP API has no such start step, so in Cursor the extension registers the connector without a token and the connector reads the Keychain item instead.

**A token from the Keychain reaches the read-only tools only.** The extension never confirmed the token in the Keychain item, and another app's setup may have saved a full-access token there. So every connector that reads it runs with `--read-only`: Cursor's, the pasted Copy Config entry, and VS Code's server while no token is set in the editor. Recording control, follow-ups and `setup_claude` need a token set with **Wisply: Set Token…**, which asks you to confirm a full-access token.

**The identity check.** Any program can listen on Wisply's port while Wisply is closed. Before every use of the token, the bundled connector asks the listener, without the token, for an HMAC-SHA256 proof over a fresh random nonce and the port, and checks it in constant time. If the answer doesn't prove the token, the token is not sent. There is a short gap between the check and the call, and the check relies on Wisply holding its port alone while it runs; the default read-only token limits what either gap could expose. The connector's own [SECURITY.md](https://github.com/fal3/wisply-mcp/blob/main/SECURITY.md) has the details.

**Network.** The connector talks only to `127.0.0.1`, with its own HTTP agent (proxy variables are ignored) and no redirects, and caps every answer in size and time. The extension's own code (`dist/extension.js`) has no network code at all: the editor patches network requests from extension code to follow its proxy settings, so the token is sent only from the plain Node processes above. There is no telemetry, crash reporting or update check.

**Settings a repository can't change.** Every `wisply.*` setting is read only from your user settings (`inspect().globalValue`), has `application` scope and is restricted in Restricted Mode. A repository's `.vscode/settings.json` can't turn on `setup_claude`, point the extension at another port or change what Insert Transcript Quote writes. Neither can a dev container's `devcontainer.json` or a remote machine's settings: `machine` scope would take those remote settings, but VS Code never reads an `application` setting from them. `wisply.port` and `wisply.mcp.allowClaudeSetup` are also `ignoreSync`, so Settings Sync doesn't copy them to your other computers.

**The environment.** `WISPLY_MCP_TOKEN`, `WISPLY_MCP_ALLOW_CLAUDE_SETUP`, `WISPLY_MCP_DEBUG` and `NODE_OPTIONS` exported in your shell for another app are removed from the server the editor starts. The Keychain setup terminal starts with a fixed, minimal environment, so nothing such as a debugger's `NODE_OPTIONS` loads code into the process that handles the token.

**Recorded speech.** Transcripts and memo titles are untrusted text: anyone who speaks in a recorded meeting chooses some of it, and so does anyone who sends a calendar invite, because a memo can be named after its meeting. The status bar item never shows any. Insert Transcript Quote:

- removes terminal escapes, control, invisible and text-direction characters and folds line breaks, so a quote is one line of visible text;
- in a Markdown quote, escapes the text, the title and the date: `<`, `>` and entity-like `&` become entities, and `` ` ``, `*`, `_`, `[`, `]`, `~`, `\` and a heading or list marker at the start of the line get a backslash. A link, image, raw HTML, autolink or formatting that someone said or put in a title shows as typed, and a Markdown preview or GitHub renders no link target, no remote image and no HTML from it;
- in a plain quote, breaks up link and image syntax (`](`) and HTML and autolink openers (`<` before a letter, `/`, `!` or `?`) with a space;
- attributes every quote to "Wisply recording (quoted speech)" (plain: "Wisply recording, quoted speech"), so an AI agent that later reads the file sees that the text is someone's speech.

Match lists can't draw icons from memo text. The bundled skill tells the AI to treat transcripts it reads through the tools as quoted data, never as instructions.

What's left: a web address someone said stays visible as said, and Markdown viewers may make it clickable. A quote is still someone else's words inside your file. An AI agent in the editor reads workspace files as ordinary content, outside the skill's rules for tool results, and the attribution is a hint it may ignore. Don't ask an agent to act on a file that holds quotes without reading what it plans to do.

**Logs.** The extension writes no logs of your memos. The connector's debug lines stay off in the processes the extension and the editor start, because `WISPLY_MCP_DEBUG` never reaches them; even when on, they hold only fixed fields (method, tool name, outcome, HTTP status, bytes and milliseconds). The editor's own MCP log (**MCP: Show Output**) can record tool results, memo text included, if you raise its log level to Debug or Trace.

**The Keychain item.** **Wisply: Store Token in the Mac Keychain…** keeps the token in your login keychain (service `ai.wisply.mcp`, account `token`, label "Wisply MCP token"), out of config files, Settings Sync and dotfile repositories. It does **not** stop another program running as you on this Mac from reading it, because the item trusts `/usr/bin/security`. Use the read-only connector token, and regenerate it in Wisply if you suspect malware. The terminal refuses the full-access token. It keeps a recording-control token (`wspr_`) and says what that means: every other AI app on this Mac that reads the item without a token of its own can then start and stop recordings while Wisply allows agents to (this extension's connectors still get only the read-only memo tools from it). If the connector says Wisply couldn't read its own tokens from the Keychain, quit and reopen Wisply; any program on the port can send that answer, so allow a Keychain access dialog only when it names Wisply.

**What your AI chat does with what it reads.** Whatever the chat reads from Wisply goes to the AI service your editor uses, under that service's terms.

**Supply chain.** The extension has no runtime dependencies. The connector, the plugin's helpers and the skill are vendored at exact commits with their sha256 in `vendor/SOURCE.json`, and the tests fail if any vendored file, the bundle or the packaged skill differs from what those sources build. The release gate checks the same before every package or publish (see below). The package holds only what runs and what the stores show (`vsce ls` is tested), and nothing in it looks like a token.

## If you think a token leaked

1. In Wisply, open **Settings > Integrations > MCP Server** and regenerate the token. Every client using the old token stops working at once.
2. Run **Wisply: Set Token…** with the new token. If you used the Keychain, run **Wisply: Store Token in the Mac Keychain…** again, or delete "Wisply MCP token" in Keychain Access.
3. **Wisply: Forget Token** removes the token from the editor. A Wisply MCP server that is already running keeps it until it restarts.
4. Turn the MCP server off in Wisply if you don't use it. Wisply stops answering MCP requests at once; if Wisply Companion is set up, the same local listener stays on for it.

## Release controls (maintainers)

- `vsce package`, `vsce publish` and `ovsx publish` run the release gate (`scripts/release-gate.mjs`) first, and nothing turns it into a warning. It refuses while the vendored connector or skill isn't from `fal3/wisply-mcp` `main` as GitHub has it, with a final contract; while any file `vendor/SOURCE.json` records (the vendored files, the vendored and packaged skill, the bundle) differs from its sha256, the packaged skill isn't the vendored one with only its compatibility line replaced, or a rebuild from `vendor/` and `src/editor-messages.mjs` doesn't give the bundle byte for byte; while the checkout has uncommitted changes; while the publisher ID, the setup guide link, the public repositories or the support page and the mailbox are placeholders, or the package names a mailbox other than support@wisply.ai; and while the README reads as a draft or has a `{PLACEHOLDER}`.
- `npm run package` builds a development package only (`wisply-dev.vsix`): another extension, `wisply.wisply-dev`, with a prerelease version that `vsce publish` and the Marketplace refuse, so it can't be published as this extension.
- Publish from a clean checkout of a release tag: `npm ci`, `npm run check`, `WISPLY_RELEASE=1 npm test`, then `npm run package:release` and review `npx vsce ls --no-dependencies` before uploading. [PUBLISHING.md](https://github.com/fal3/wisply-vscode/blob/main/PUBLISHING.md) is the runbook.
- **If a bad version is published:** remove that version from the VS Code Marketplace (Manage Publishers) and from Open VSX, publish a fixed version, publish a GitHub security advisory here, and say in this changelog and on wisply.ai which tokens to regenerate.
