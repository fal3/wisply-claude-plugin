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

## Every release, dark or lit

The README section pins the Codex marketplace to the release tag,
`codex plugin marketplace add fal3/wisply-mcp --ref v<version>`, like the
local install. Codex keeps one ref per marketplace and both plugins share the
`wisply` marketplace, so an unpinned add would move the local plugin to `main`
as well. `check` (and so `npm test`) fails until the tag in
`cloud-connect/README-cloud.md` equals `v` + `package.json` `version`: bump
it with the other versions (SECURITY.md "Release controls" step 6, which
lists this file), and when lit, re-run step 1's `apply` (the date and name
may be left out) so the README block follows.

## Light it (after Cloud Connect stage 4)

Preconditions:

- Cloud Connect stage 4 is done (`CLOUD_CONNECT_ALLOWED_USER_IDS` unset in
  Production), and wisply.ai/docs/cloud-connect and the privacy policy's
  Cloud Connect section are live.
- That privacy section covers the requests an installed plugin's app makes
  before anyone signs in: unauthenticated `POST /mcp`, the OAuth discovery
  documents and `/oauth/register`, which give wisply.ai (and Vercel's request
  logs) the IP address and the app's user agent, and an IP hash for the
  `/oauth/register` rate limit. Cloud Connect's privacy text
  (cloud-connect-design.md, "Privacy policy") doesn't say this yet; until it
  does, the "sees your IP address" sentences in both sections point at a
  policy that doesn't back them. That's a Cloud Connect W8 (privacy page)
  change.
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
3. Bump the version for the next release (SECURITY.md "Release controls",
   including the README section's `--ref`; see "Every release" above), add a
   CHANGELOG line, merge, and release as usual. The npm README carries the new
   section; the npm code doesn't change.
4. Alex, after the release tag exists:
   - **Codex:** nothing to submit. Who sees **wisply-cloud** in `/plugins`
     depends on how they added the marketplace:
     - with this release's tag (the README command): at once;
     - with an older tag (every earlier README said `--ref v<that release>`):
       never through `codex plugin marketplace upgrade`, which fetches the
       same tag again (`codex-rs/core-plugins/src/marketplace_upgrade.rs:237-247`
       @deede72). They run `codex plugin marketplace remove wisply`, then the
       add command with the new tag: Codex refuses a second ref for a
       marketplace it already has ("remove it before adding this source",
       `marketplace_add.rs:177-180`). The README section says so;
     - without a ref (following `main`): after
       `codex plugin marketplace upgrade wisply`.
   - **`github/awesome-copilot`** (VS Code and Copilot CLI): a **new**
     external-plugin issue for `wisply-cloud`: path `cloud-connect/plugin`, the
     release tag as `ref` and its full 40-character `sha`, version from
     `cloud-connect/plugin/plugin.json`, license `MIT`, author `Wisply`,
     homepage `https://www.wisply.ai/docs/cloud-connect`, keywords
     `wisply, meetings, transcripts, mcp, cloud, remote`, and in the notes:
     "Separate opt-in plugin; the app connects to https://www.wisply.ai/mcp
     and signs in with OAuth." The local `wisply` listing doesn't change.
   - **Cursor Marketplace:** see "Cursor" below. Until Cursor confirms its
     rules, Cursor users add the address from Cursor's MCP settings (README
     section). The local `wisply` listing doesn't change.
   - **wisply.ai:** the `/docs/mcp/install` page and the `local-ai-tools`
     privacy block keep describing the local plugin only. Link the cloud
     plugin from wisply.ai/docs/cloud-connect, as its own opt-in option.
   - **MCP Registry:** `mcp-publisher publish registry/cloud.server.json`
     (DIST-M3 file; distribution spec, Alex action 5).

## Cursor

Cursor lists several plugins from one repository through a
`.cursor-plugin/marketplace.json` whose `plugins[].source` is each plugin's
folder, relative to the repository root (`cursor/plugin-template` @4621607:
`README.md:20-24` "This template defaults to multi-plugin",
`.cursor-plugin/marketplace.json`, `docs/add-a-plugin.md`). For Wisply that
file would list both plugins:

```json
{
  "name": "wisply",
  "owner": { "name": "Wisply", "email": "support@wisply.ai" },
  "metadata": { "description": "Wisply meeting notes in Cursor: on this Mac, or from Wisply Cloud" },
  "plugins": [
    { "name": "wisply", "source": "./", "description": "Your Wisply meeting notes, from the Wisply app on this Mac." },
    { "name": "wisply-cloud", "source": "./cloud-connect/plugin", "description": "Your Wisply Cloud memos, read from wisply.ai with Cloud Connect (Wisply Pro)." }
  ]
}
```

It isn't staged and `apply` doesn't write it, because two things are
unverified. Alex asks both in the Cursor submission (cursor.com/marketplace/publish,
or the template's contact):

1. Does Cursor accept a root source (`./`) in a multi-plugin marketplace? The
   template shows only subfolders (`./plugins/...`), and says a single-plugin
   repository removes `marketplace.json` (`README.md:24`), which is what the
   root plugin is today.
2. Does each plugin folder need `.cursor-plugin/plugin.json`, or is the Agent
   Plugins `plugin.json` enough? The template's validator reads only
   `.cursor-plugin/plugin.json` (`scripts/validate-template.mjs:319`).

The file changes nothing for Codex, which reads `.agents/plugins/marketplace.json`
first (`codex-rs/core-plugins/src/marketplace.rs:20-25,328-337` @deede72). If
Cursor says yes to both, add it by hand in the lighting change or later:
`check` accepts a `wisply-cloud` entry there only while the plugin is lit and
only at `./cloud-connect/plugin`, and `remove` unlists it there too.

## Retract it (new installs only)

1. `node scripts/cloud-entry.mjs remove` unlists the plugin from
   `.agents/plugins/marketplace.json` (and `.cursor-plugin/marketplace.json`
   if it lists it), and removes both sections and `LIT.json`. Release as
   above.
2. Alex: `remove` doesn't touch the listings outside this repository, and
   each keeps offering `wisply-cloud` to new installs until it's withdrawn:
   - **MCP Registry:**
     `mcp-publisher status --status deprecated --message "<reason>" ai.wisply/cloud <version>`
     (`--status deleted` to hide it, `--all-versions` for every version;
     `modelcontextprotocol/registry` @11b7b0e,
     `cmd/publisher/commands/status.go:58-91`). Catalogs that copy the
     registry (the VS Code and GitHub MCP galleries, Glama, PulseMCP) may show
     a cached entry for a while.
   - **`github/awesome-copilot`:** comment on the approved `wisply-cloud`
     submission issue asking the maintainers to remove it. They remove
     listings with `/re-review-remove`, which opens the pull request that
     takes the entry out of `plugins/external.json` (`CONTRIBUTING.md`
     @29bb2c6, "Review cadence and label semantics").
   - **Cursor:** ask Cursor, through the submission contact, to delist
     `wisply-cloud`.
   - **wisply.ai:** remove the plugin link from wisply.ai/docs/cloud-connect.
3. None of this reaches anyone who already installed `wisply-cloud`:
   installed plugins, the awesome-copilot entry (pinned to a sha) and Cursor
   installs keep it until they update or are re-submitted. For them, use the
   server-side controls below.

## Server-side controls

These reach apps that are already connected:

- `CLOUD_CONNECT_ENABLED` unset in Production, then redeploy: every Cloud
  Connect route, `/mcp` included, answers `503 CLOUD_UNAVAILABLE`
  (cloud-connect-design.md, "Rollout", Kill switch row).
- Every grant at once: the emergency token kill in the same row,
  `UPDATE oauth_grants SET revoked_at = now() WHERE revoked_at IS NULL`. Every
  connected app has to sign in again.
- One app: the user's Disconnect (wisply.ai/account or Wisply), or turning
  Cloud Connect off, revokes that app's grant at once.

Not a kill switch: setting `CLOUD_CONNECT_ALLOWED_USER_IDS` again only stops
new accounts from turning Cloud Connect on (`POST /api/cloud/account` answers
`403 CLOUD_CONNECT_NOT_ALLOWED`) and hides the app's Cloud Connect UI
(`staged: true`). `/mcp` doesn't check the allow-list (`handleMcpRequest`:
availability, bearer token, rate limit, handler), so accounts that turned
Cloud Connect on keep their connections and their apps keep reading. A
narrower switch, such as one for plugin clients only, would be a Cloud
Connect W-lane requirement.

## Verified client behavior

- Codex names a plugin's servers by their `mcp.json` key, so the server is
  `wisply-cloud` and `codex mcp login wisply-cloud` works
  (`openai/codex` @deede72: `codex-rs/codex-mcp/src/agent_plugin_config.rs:98-107`,
  `codex-rs/core-plugins/src/loader.rs:193-205`, `codex-rs/cli/src/mcp_cmd.rs:543-558`).
- Codex local plugin sources other than the root must start with `./` and
  stay inside the repository (`codex-rs/core-plugins/src/marketplace.rs:677-720`);
  a marketplace entry without `policy` is `AVAILABLE`, never
  `INSTALLED_BY_DEFAULT` (`marketplace.rs:167-184`).
- Codex stores the ref with the marketplace and `upgrade` fetches that ref
  again; adding the same repository at another ref is refused until the
  marketplace is removed (`marketplace_upgrade.rs:237-247`,
  `marketplace_add.rs:177-180`, `marketplace_add/metadata.rs:179-193`).
- VS Code installs a plugin at a relative path only through a marketplace
  index (`microsoft/vscode-docs` @1c060e1,
  `docs/agent-customization/agent-plugins.md`); **Chat: Install Plugin From
  Source** takes the repository root, which is the local plugin.
- `code --add-mcp` takes `{"name", "type": "http", "url"}`
  (`docs/agents/reference/mcp-configuration.md:194,396-401`).

## Differs from the distribution design

The distribution spec (`2026-10-21-distribution-design.md`) still describes
the first approach: Goal 7 (line 123, "remote variants in the Agent Plugin"),
the remote-directories row for Agent Plugin clients (line 1082, "A second
`mcp.json` server entry, `wisply-cloud`"), the rollout row (line 1450) and the
DIST-M6 work-plan row (line 1487, "`mcp.json` remote entry `wisply-cloud`").
Followed literally, those rows put the remote in the root `mcp.json`, which
`check` refuses. What DIST-M6 builds instead: the separate opt-in plugin in
`cloud-connect/plugin/` (`plugin.json`, `mcp.json`), its Codex marketplace
entry (`cloud-connect/marketplace-entry.json`), the staged README and
SECURITY sections, `LIT.json`, `scripts/cloud-entry.mjs` and
`tests/cloud-entry.test.mjs`; validation is `npm run check` on the tree
merged after DIST-M5. DIST-M5 records the change in
`docs/design-differences.md` ("The remote is its own plugin"). The spec rows
and a decision row (D22: "Cloud remote in the Agent Plugin: second root
`mcp.json` entry / separate opt-in plugin → separate opt-in plugin, because
clients start every server of an installed plugin, so a root entry would make
every local user's app contact wisply.ai, against the 127.0.0.1-only rule")
are a spec-repo change for Alex or a spec-lane agent.
