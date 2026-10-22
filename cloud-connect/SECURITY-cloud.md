## The Wisply Cloud plugin (`wisply-cloud`)

This repository also holds a second, separate Agent Plugin, `wisply-cloud` (in `cloud-connect/plugin/`), for [Cloud Connect](https://www.wisply.ai/docs/cloud-connect). It's opt-in: installing the `wisply` plugin or running `@wisply/mcp` never adds it.

- **Network.** `wisply-cloud` makes your AI app connect to `https://www.wisply.ai/mcp`. The app makes that connection, not this package, and it may do so whenever it starts the plugin's server, even before you sign in. Before sign-in that connection carries no memo content, but wisply.ai sees your IP address and your app's user agent, as with any website visit (see the Cloud Connect section of the [privacy policy](https://www.wisply.ai/privacy)). `@wisply/mcp` still talks only to `127.0.0.1`.
- **Pinning.** Codex installs both plugins from one marketplace, this repository at a git ref, so the README pins it to the release tag with `--ref`, as for the local plugin (see "Git installs" above).
- **Credentials.** The plugin holds only the address: no token and no headers. Your AI app signs in to your Wisply account with OAuth and keeps those tokens in its own storage. They're separate from the local `wsp_`, `wspc_` and `wspr_` tokens, and neither kind belongs in a config file.
- **Data.** The cloud tools are read-only and see only the memos you sync with Cloud Connect. What your AI app reads from Wisply Cloud is sent to the AI service that app uses, under that service's terms.
- **Revoking.** Disconnect the app at [wisply.ai/account](https://www.wisply.ai/account) or in Wisply (Settings > Integrations > Cloud Connect): its tokens stop working at once. Turning Cloud Connect off deletes the cloud copy and disconnects every app.
- **Reporting.** Report a problem with Wisply Cloud the same way as any other (see "Reporting a problem").
