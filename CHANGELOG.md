# Changelog

All notable changes to the Wisply extension for VS Code and Open VSX editors are listed here. Versions follow [Semantic Versioning](https://semver.org/).

## Unreleased (0.1.0)

### Added

- **MCP server "Wisply (this Mac)"** in VS Code 1.101 and later (`vscode.lm.registerMcpServerDefinitionProvider`). It runs the Wisply connector bundled in the extension on the editor's own Node: no `npx`, no download, and it talks only to Wisply at 127.0.0.1. The server definitions the extension lists never contain the token; it is added only when the server starts. Each token change restarts a running server or offers to, except for the token entered when the server first starts, which that start already uses.
- **Wisply: Set Token…** stores the read-only connector token in the editor's secret storage. A full-access token needs a second confirmation; a recording-only token is refused. **Wisply: Forget Token** removes it.
- **Wisply: Check Connection** checks that Wisply answers and proves its identity, and how many tools the token reaches.
- **Wisply: Store Token in the Mac Keychain…** opens a terminal where macOS's `security` tool asks for the token, for Cursor and other apps on this Mac. The terminal starts with a fixed, minimal environment.
- **Cursor and other editors:** where VS Code's MCP API is missing, the extension registers the same connector with Cursor's API, without a token (it reads the Keychain item), or offers a token-free entry to paste. A token from the Keychain reaches the read-only memo tools only.
- **Status bar item** with Wisply's recording state: the recording's length while recording, a pause icon while paused, and an icon for no token, Wisply not answering and other problems. The tooltip shows the word and speaker counts, never what was said. It checks only while the window is focused (every 10 s during a recording, 30 s otherwise, 60 s when Wisply isn't answering or is a build that ignores `tail_words`), and opens a menu with the Wisply commands and **Hide Status Item**.
- **Wisply: Insert Transcript Quote** puts the last words of the recording in progress at the cursor, or searches your memos and inserts the excerpt you pick, as a Markdown block quote or one plain line, in a single undoable edit. Recorded speech is reduced to visible text on one line first.
- **The "wisply-memos" skill** for AI chat (`contributes.chatSkills`), the same portable skill as the Wisply connector's, with its compatibility line naming this extension.
- Settings `wisply.port`, `wisply.mcp.allowClaudeSetup` (off), `wisply.statusBar.enabled`, `wisply.quote.words` (80) and `wisply.quote.format` (`markdown`). All are `application` settings, read from the local user settings only (never from a workspace, a dev container or a remote machine), and restricted in Restricted Mode. Settings Sync doesn't copy `wisply.port` and `wisply.mcp.allowClaudeSetup`.
- The icon, the store README with what the extension sends where, and [SECURITY.md](SECURITY.md).

### Security

- The extension host never sends the token. The editor's MCP server and the read-only helper process that serves the status bar item, quotes and Check Connection are plain Node processes that run Wisply's identity check before each use of the token, outside the editor's proxy handling.
- `WISPLY_MCP_TOKEN`, `WISPLY_MCP_ALLOW_CLAUDE_SETUP`, `WISPLY_MCP_DEBUG` and `NODE_OPTIONS` from your shell never reach the connector the editor starts.
- A release package or a publish is refused while the bundled connector or the skill isn't from `fal3/wisply-mcp` `main` as GitHub has it, while a name, link or address in the package is provisional, and while the store README is a draft. `npm run package` builds a separate development extension (`wisply.wisply-dev`, a prerelease version) that can't be published as this one.
- The setup terminal's texts and the connector's chat texts name the extension's commands, never a package or a shell command.
