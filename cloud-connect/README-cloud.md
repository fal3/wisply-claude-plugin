## Cloud

With [Cloud Connect](https://www.wisply.ai/docs/cloud-connect) (Wisply Pro), your AI app can also read the memos you sync to Wisply Cloud, from any computer, even when your Mac is off. The plugin in this repository adds a second MCP server for that, `wisply-cloud`, in Codex, Cursor, VS Code and GitHub Copilot CLI. The `npx -y @wisply/mcp@0` setups above don't add it.

| | `wisply` (this Mac) | `wisply-cloud` (Wisply Cloud) |
|---|---|---|
| Server | `@wisply/mcp`, which talks only to the Wisply app at 127.0.0.1 | `https://www.wisply.ai/mcp` (Streamable HTTP) |
| What it reads | Your memos in Wisply on this Mac, and the recording in progress | Only the memos you sync with Cloud Connect, from each device where you turned it on |
| You need | Wisply for Mac with the MCP server turned on, and the token saved by `npx -y @wisply/mcp setup` | A Wisply account with Wisply Pro, and Cloud Connect turned on in Wisply (Settings > Integrations > Cloud Connect) |
| Sign-in | The connector token, from your login keychain or your app's secret storage | Your AI app signs in to Wisply the first time it connects. You approve it on wisply.ai and choose whether it can read full transcripts |
| Tools | Read tools, plus recording control and follow-ups with a token that allows them | Eight read-only tools: `search_memos`, `list_memos`, `get_memo`, `get_transcript`, `get_action_items`, `get_account_status`, `search`, `fetch` |

- The plugin's `wisply-cloud` entry holds only the address, never a token. Your AI app keeps the sign-in in its own storage.
- In Codex, run `codex mcp login wisply-cloud` when Codex says the server isn't logged in.
- `@wisply/mcp` never contacts wisply.ai. Your AI app makes the remote connection itself.
- What your AI app reads from Wisply Cloud is sent to the AI service that app uses, under that service's terms. Access history at [wisply.ai/account](https://www.wisply.ai/account) lists every read for 90 days.
- Disconnect an app at [wisply.ai/account](https://www.wisply.ai/account) or in Wisply > Settings > Integrations > Cloud Connect. Turning Cloud Connect off deletes the cloud copy and disconnects every app.
- Until you sign in, or if your app can't sign in to remote MCP servers, it may show `wisply-cloud` as disconnected. The local `wisply` server isn't affected. If you only want the local server, turn `wisply-cloud` off in your app's list of MCP servers.
- If you already added `https://www.wisply.ai/mcp` to this app by hand, remove that entry, or the cloud tools show up twice.
- Claude, ChatGPT, Microsoft 365 Copilot and Gemini connect to Wisply Cloud from their own connector settings. See [wisply.ai/docs/cloud-connect](https://www.wisply.ai/docs/cloud-connect).
