## Cloud

With [Cloud Connect](https://www.wisply.ai/docs/cloud-connect) (Wisply Pro), your AI app can also read the memos you sync to Wisply Cloud, from any computer, even when your Mac is off. That takes a separate plugin, `wisply-cloud`, which you install only if you want it. The `wisply` plugin and the `npx` setups above stay local: they never contact wisply.ai.

| | `wisply` (this Mac) | `wisply-cloud` (Wisply Cloud) |
|---|---|---|
| Server | `@wisply/mcp`, which talks only to the Wisply app at 127.0.0.1 | `https://www.wisply.ai/mcp` (Streamable HTTP) |
| What it reads | Your memos in Wisply on this Mac, and the recording in progress | Only the memos you sync with Cloud Connect, from each device where you turned it on |
| You need | Wisply for Mac with the MCP server turned on, and a connector token | A Wisply account with Wisply Pro, and Cloud Connect turned on in Wisply (Settings > Integrations > Cloud Connect) |
| Sign-in | The connector token, from your login keychain or your app's secret storage | Your AI app signs in to Wisply the first time it connects. You approve it on wisply.ai and choose whether it can read full transcripts |
| Tools | Read tools, plus recording control and follow-ups with a token that allows them | Eight read-only tools: `search_memos`, `list_memos`, `get_memo`, `get_transcript`, `get_action_items`, `get_account_status`, `search`, `fetch` |

To add `wisply-cloud`:

- **Codex:** `codex plugin marketplace add fal3/wisply-mcp --ref v0.1.0`, then install **wisply-cloud** in `/plugins`. If you added the `wisply` marketplace for an earlier release, run `codex plugin marketplace remove wisply` before the add: Codex keeps one tag per marketplace, and `codex plugin marketplace upgrade` fetches that same tag again. Keep the tag: both plugins come from this marketplace, and without one Codex would follow `main` for the local plugin too. When Codex says the server isn't logged in, run `codex mcp login wisply-cloud`.
- **VS Code:** `code --add-mcp '{"name":"wisply-cloud","type":"http","url":"https://www.wisply.ai/mcp"}'`, or install **wisply-cloud** from the Agent Plugins view once it's listed there.
- **Other apps that support remote MCP servers:** add `https://www.wisply.ai/mcp` as a remote (Streamable HTTP) server. Claude, ChatGPT, Microsoft 365 Copilot and Gemini connect from their own connector settings. See [wisply.ai/docs/cloud-connect](https://www.wisply.ai/docs/cloud-connect).

Good to know:

- `wisply-cloud` holds only the address, never a token. Your AI app keeps the sign-in in its own storage and makes the connection to wisply.ai itself. `@wisply/mcp` never contacts wisply.ai.
- Once `wisply-cloud` is installed, your AI app may connect to wisply.ai whenever it starts, even before you sign in. That connection sends no memo content, but wisply.ai sees your IP address and your app's name (its user agent), as with any website visit (see the Cloud Connect section of the [privacy policy](https://www.wisply.ai/privacy)). To stop that, turn `wisply-cloud` off or uninstall it in your app.
- What your AI app reads from Wisply Cloud is sent to the AI service that app uses, under that service's terms. Access history at [wisply.ai/account](https://www.wisply.ai/account) shows recent reads by each connected app (what, when, which app); records are kept for 90 days.
- Disconnect an app at [wisply.ai/account](https://www.wisply.ai/account) or in Wisply > Settings > Integrations > Cloud Connect. Turning Cloud Connect off deletes the cloud copy and disconnects every app.
- Use one way per app: the plugin or the address added by hand. With both, the cloud tools show up twice.
- With `wisply` and `wisply-cloud` both on, `list_memos` and `get_action_items` exist on both servers. To be sure which one answers, say so: ask for "Wisply Cloud" or "my other devices" for the cloud copy, and "on this Mac" or "the recording in progress" for the local one.
