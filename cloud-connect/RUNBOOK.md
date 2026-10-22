# Wisply Cloud plugin: lighting and retracting (maintainers)

`wisply-cloud` is the Agent Plugin for Cloud Connect's remote MCP server,
`https://www.wisply.ai/mcp`. It is a **separate, opt-in plugin** in
`cloud-connect/plugin/`, never a second server in the root `mcp.json`: Agent
Plugins clients (Codex, Cursor, VS Code, GitHub Copilot CLI) load every server
of an installed plugin and can start it as soon as the app starts, so a remote
entry in the local `wisply` plugin would make local users' apps contact
wisply.ai, with or without Wisply Pro.
`node scripts/cloud-entry.mjs check` fails if the root plugin ever holds a
remote server.

The plugin stays **dark** (in the repository, but not listed anywhere) until
Cloud Connect stage 4: the allow-list is removed and the remote server is open
to every Pro account.

## Files

| Path | Role |
|---|---|
| `cloud-connect/plugin/plugin.json`, `cloud-connect/plugin/mcp.json` | The plugin itself (Agent Plugins 1.0.0). Permanent; only the streamable-http entry, no headers, no token |
| `cloud-connect/marketplace-entry.json` | The entry `apply` adds to the Codex marketplace, `.agents/plugins/marketplace.json`, after the local `wisply` entry |
| `cloud-connect/README-cloud.md`, `cloud-connect/SECURITY-cloud.md` | The sections `apply` adds to `README.md` and `SECURITY.md`, between `<!-- wisply-cloud:start -->` and `<!-- wisply-cloud:end -->` |
| `cloud-connect/LIT.json` | Written by `apply`: the stage-4 date and who approved lighting. CI (`tests/cloud-entry.test.mjs`) accepts the lit state only with a valid record |
| `scripts/cloud-entry.mjs` | `check`, `apply`, `remove`. Dev-only: none of these files is in the npm package |

Edit a section in `cloud-connect/`, never between the markers: `check` fails
on a block that differs from its staged file, and `apply` re-syncs it.

## Light it (after Cloud Connect stage 4)

Preconditions:

- Cloud Connect stage 4 is done (`CLOUD_CONNECT_ALLOWED_USER_IDS` unset in
  Production), and wisply.ai/docs/cloud-connect and the privacy policy's
  Cloud Connect section are live.
- DIST-M1 and DIST-M3 are merged (`README.md`, `SECURITY.md`, `mcp.json`,
  `.agents/plugins/marketplace.json` exist).
- `node --test tests/cloud-entry.test.mjs` passes with `WISPLY_WEB_DIR` and
  `WISPLY_AI_DIR` pointing at current checkouts, so the URL and the tool list
  match what Cloud Connect serves.

Steps:

1. On a branch:
   `node scripts/cloud-entry.mjs apply --confirm-cloud-connect-stage-4 --stage-4-date YYYY-MM-DD --approved-by "<name>"`
2. `npm run check`. Review the diff: the marketplace entry, the two sections
   and `cloud-connect/LIT.json`. The root `plugin.json` and `mcp.json` don't
   change.
3. Bump the version for the next release (SECURITY.md "Release controls"),
   add a CHANGELOG line, merge, and release as usual. The npm README carries
   the new section; the npm code doesn't change.
4. Alex, after the release tag exists:
   - **Codex:** nothing to submit. Users who added the marketplace see
     **wisply-cloud** in `/plugins` after `codex plugin marketplace upgrade wisply`.
   - **`github/awesome-copilot`** (VS Code and Copilot CLI): a **new**
     external-plugin issue for `wisply-cloud`: path `cloud-connect/plugin`, the
     release tag as `ref` and its full 40-character `sha`, version from
     `cloud-connect/plugin/plugin.json`, license `MIT`, author `Wisply`,
     homepage `https://www.wisply.ai/docs/cloud-connect`, keywords
     `wisply, meetings, transcripts, mcp, cloud, remote`, and in the notes:
     "Separate opt-in plugin; the app connects to https://www.wisply.ai/mcp
     and signs in with OAuth." The local `wisply` listing doesn't change.
   - **Cursor Marketplace:** ask in a new submission whether a second plugin
     from the same repository (`cloud-connect/plugin`) can be listed. Not
     verified yet; if it can't, Cursor users add the address from Cursor's MCP
     settings (README section). The local `wisply` listing doesn't change.
   - **wisply.ai:** the `/docs/mcp/install` page and the `local-ai-tools`
     privacy block keep describing the local plugin only. Link the cloud
     plugin from wisply.ai/docs/cloud-connect, as its own opt-in option.
   - **MCP Registry:** `mcp-publisher publish registry/cloud.server.json`
     (DIST-M3 file; distribution spec, Alex action 5).

## Retract it (new installs only)

`node scripts/cloud-entry.mjs remove` unlists the plugin and removes both
sections and `LIT.json`, then release as above. It doesn't reach anyone who
already installed `wisply-cloud`: installed plugins, the awesome-copilot entry
(pinned to a sha) and Cursor installs keep it until they update or are
re-submitted.

## Kill switches (server-side, reach every install)

- `CLOUD_CONNECT_ENABLED` off in Production: `/mcp` answers
  `503 CLOUD_UNAVAILABLE` for everyone.
- `CLOUD_CONNECT_ALLOWED_USER_IDS` set again: back to the staged allow-list.
- A user's Disconnect (wisply.ai/account or Wisply) or turning Cloud Connect
  off revokes that app's tokens at once.

## Verified client behavior

- Codex names a plugin's servers by their `mcp.json` key, so the server is
  `wisply-cloud` and `codex mcp login wisply-cloud` works
  (`openai/codex` @deede72: `codex-rs/codex-mcp/src/agent_plugin_config.rs:98-107`,
  `codex-rs/core-plugins/src/loader.rs:193-205`, `codex-rs/cli/src/mcp_cmd.rs:543-558`).
- Codex local plugin sources other than the root must start with `./` and
  stay inside the repository (`codex-rs/core-plugins/src/marketplace.rs:677-720`);
  a marketplace entry without `policy` is `AVAILABLE`, never
  `INSTALLED_BY_DEFAULT` (`marketplace.rs:167-184`).
- VS Code installs a plugin at a relative path only through a marketplace
  index (`microsoft/vscode-docs` @1c060e1,
  `docs/agent-customization/agent-plugins.md`); **Chat: Install Plugin From
  Source** takes the repository root, which is the local plugin.
- `code --add-mcp` takes `{"name", "type": "http", "url"}`
  (`docs/agents/reference/mcp-configuration.md:194,396-401`).
