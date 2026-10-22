# Wisply for VS Code

Use your Wisply meeting notes, action items and live transcript in your editor's AI chat, from the Wisply app on this Mac.

> **Not published yet.** The publisher ID `wisply` is a placeholder until it is registered on the VS Code Marketplace and Open VSX, and the setup guide link goes live with the wisply.ai install page. The source repositories, the support page and the mailbox in `package.json` must be public and live too. The bundled connector is an interim snapshot (see [Vendored code](#vendored-code)). The release gate refuses a release package or a publish until all of these are final and this draft README is replaced. This repository holds the core extension (DIST-V1); the status bar item, Insert Transcript Quote, the bundled skill, the icon and the store README follow in DIST-V2.

## What it does

- **MCP server "Wisply (this Mac)".** In VS Code 1.101 and later, the extension registers Wisply's connector with `vscode.lm.registerMcpServerDefinitionProvider`. It shows up in VS Code's MCP server list and in chat tools. VS Code starts it like any MCP server an installed extension provides, with no trust prompt of its own; in Restricted Mode it asks you to trust the workspace first.
- **Your token stays in the editor's secret storage.** Run **Wisply: Set Token…** and paste the read-only connector token from Wisply > Settings > Integrations > MCP Server. The server definitions the extension lists never contain the token. The token is added only when the server starts.
- **Cursor and other editors.** Where VS Code's MCP API is missing but Cursor's `vscode.cursor.mcp.registerServer` exists, the extension registers the same connector there, without a token. That connector reads the token saved in the Mac Keychain, so run **Wisply: Store Token in the Mac Keychain…** once. In an editor with neither API, a one-time notice offers a token-free entry to paste. The entry runs the connector inside the extension, as the other two do. It never runs an npm package. The extension's folder changes when it updates, so copy the entry again after an update.
- **A token from the Mac Keychain gets the read-only memo tools only.** The extension never confirmed that token, and another app's `setup --full-access` may have saved a full-access one there. So Cursor's connector, the pasted entry, and VS Code's server while no token is set all run with `--read-only`: list and search memos, the live transcript and action items, nothing that starts a recording or proposes a follow-up. Recording control, follow-ups and `setup_claude` need a token set with **Wisply: Set Token…**, which asks you to confirm a full-access token (VS Code 1.101 and later).
- **A new token reaches a running server.** Each time the token is set, replaced or forgotten (in any window), the server definition gets a new version, and VS Code restarts the server or offers to: it still has the old token until then. The token you enter when the server first starts is the exception: that start already uses it, so it isn't restarted.
- **Commands:** Set Token…, Forget Token, Check Connection, Store Token in the Mac Keychain…, Open Setup Guide.
- **Settings:** `wisply.port` (default 51771) and `wisply.mcp.allowClaudeSetup` (default off). They are read only from your user settings on this computer. A repository can't change them: not with `.vscode/settings.json`, and not with a dev container's `devcontainer.json` or a remote machine's settings, because both are `application` settings, which VS Code never reads from remote settings. Restricted Mode ignores workspace values too. Settings Sync doesn't copy them (`ignoreSync`), so turning on `setup_claude` on one Mac leaves it off everywhere else.
- **Only on a Mac.** On Windows and Linux the server is still listed, but the extension never asks for a token there: there's no Wisply to connect to.

## Privacy

- The connector talks only to the Wisply app on this Mac, at 127.0.0.1. Before it uses your token, Wisply has to prove it holds the same token (an HMAC over a fresh nonce). Nothing is sent to anyone else, and the extension collects no analytics.
- When your editor's AI chat reads a memo, the editor sends what it read to the AI service it uses, under that service's terms.
- The extension stores your token in the editor's secret storage and keeps no logs of your memos. Your editor's own MCP log (**MCP: Show Output**) can record tool results, memo text included, if you raise its log level to Debug or Trace. Wisply's connector itself logs nothing about your memos.
- The server the editor starts gets its token and port from the extension only. `WISPLY_MCP_TOKEN`, `WISPLY_MCP_ALLOW_CLAUDE_SETUP`, `WISPLY_MCP_DEBUG` and `NODE_OPTIONS` set in your shell for another app are removed from its environment.
- **Store Token in the Mac Keychain…** keeps the token in your login keychain, out of config files and editor Settings Sync. It refuses the full-access token. macOS backs up the login keychain with the rest of your user files (Time Machine, for example), encrypted with your login password. Other programs running as you on this Mac can still read that item, so use the read-only connector token, and regenerate it in Wisply if you suspect malware. The setup terminal starts with a fixed, minimal environment, so nothing that another extension or your terminal settings add (such as `NODE_OPTIONS`) runs inside it.
- If Check Connection or chat says Wisply couldn't read its tokens from the Keychain, quit and reopen Wisply. Any program on the port can send that answer, so if macOS then asks for Keychain access, allow it only when the dialog names Wisply.
- **Forget Token** removes the token from the editor's secret storage. A server that is already running keeps it until it restarts, and a token in the Mac Keychain stays there until you delete "Wisply MCP token" in Keychain Access. To revoke the token everywhere, regenerate it in Wisply.

## Why the extension starts a process and reads the Keychain

The connector is bundled at `server/wisply-mcp.mjs`, a single-file build of [`fal3/wisply-mcp`](https://github.com/fal3/wisply-mcp). The editor runs it on its own Node (`process.execPath` with `ELECTRON_RUN_AS_NODE=1`), so there's no `npx` and no download at runtime.

The extension also runs it once more as a read-only child process (the "sidecar") for its own checks, such as Check Connection. That way the token is never sent from extension-host code, where the editor's proxy settings apply. When no token is stored, the connector reads the item "Wisply MCP token" from the login keychain through `/usr/bin/security`.

One file in the bundle doesn't come from `vendor/`: `src/editor-messages.mjs` replaces the connector's texts that tell you what to run. In chat those are no token, a malformed token, a failed identity check and Wisply's Keychain answer; in the setup terminal, every line `setup` prints that names a command. In an editor they point to **Wisply: Set Token**, **Wisply: Store Token in the Mac Keychain** and Keychain Access instead of `WISPLY_MCP_TOKEN`, `wisply-mcp setup` or an npm command, none of which exists there. The AI model in chat reads these texts too, so none of them names a package or a command it could run.

## Development

Requirements: Node 22 (vsce 4 needs it). VS Code isn't needed for the tests.

```bash
npm ci                 # .npmrc sets ignore-scripts=true
npm run check          # typecheck, tests, build, development package (wisply-dev.vsix)
```

- `npm test` builds `dist/extension.js` and each `src/*.ts` as `out/test/*.mjs`, then runs `node --test "test/*.test.mjs"`. The tests drive the pure modules with a fake `vscode` object (`test/fixtures/fake-vscode.mjs`). They run the sidecar against `test/fixtures/fake-server.mjs`, and they run the real bundle against a synthetic Wisply on a system-assigned port. No test touches port 51771 or the Keychain.
- `WISPLY_MCP_DIR=<wisply-mcp> WISPLY_PLUGIN_DIR=<wisply-claude-plugin> npm test` also compares every vendored file with the source repositories.
- `WISPLY_RELEASE=1 npm test` fails wherever the release gate would.
- `@vscode/test-electron` integration tests can't run in the agent container. They're part of the Mac QA (V1–V9 in the distribution spec).

### Packaging and the release gate

`vsce package`, `vsce publish` and `ovsx publish` all run `vscode:prepublish`, which runs `scripts/release-gate.mjs` before the build. The gate refuses while any of these is true, and nothing turns it into a warning:

- `vendor/SOURCE.json` is provisional.
- The connector wasn't vendored from `main` of `github.com/fal3/wisply-mcp`, checked against GitHub's `main` (see [Vendored code](#vendored-code)).
- A placeholder in `FINAL` isn't marked final yet: the publisher ID, the setup guide link, the two public repositories (`fal3/wisply-vscode`, `fal3/wisply-mcp`), and the support page and mailbox in `package.json`.
- `README.md`, which becomes the Marketplace and Open VSX page, still reads as a draft ("Not published yet", "interim", a `DIST-` lane name or a `claude/` branch).

There are two ways to build a `.vsix`:

- `npm run package` (`scripts/package-dev.mjs`) builds `wisply-dev.vsix` for local testing and Mac QA. It is another extension, `wisply.wisply-dev` "Wisply (development build)", version `0.1.0-dev`, built from a copy of the manifest without scripts. `vsce publish` and the Marketplace refuse prerelease versions, and Open VSX would list it as a separate extension, so it can never be published as `wisply.wisply` or use up a version number. The script prints what the release gate would refuse. Its secret storage is separate from the release extension's, so set the token again after installing it.
- `npm run package:release` builds the release `.vsix` (`wisply-<version>.vsix`) and passes the gate only when everything is final. Publish only that file. [`PUBLISHING.md`](PUBLISHING.md) is the runbook, with the note for store reviewers.

### Vendored code

`vendor/wisply-mcp/` is a byte-for-byte copy of `fal3/wisply-mcp` (`bin/`, `lib/`, the generated data modules, `LICENSE`). `vendor/shared.mjs` is the Wisply Local Connector plugin's `lib/shared.mjs`. `server/wisply-mcp.mjs` is built from them and `src/editor-messages.mjs`. `vendor/SOURCE.json` records the commits, every sha256 and that one overlay. To update them:

```bash
npm run sync-vendor -- --mcp ../wisply-mcp --mcp-commit <sha> --mcp-ref main \
  --plugin ../wisply-claude-plugin --plugin-commit <sha>
```

`sync-vendor` passes git only values that look like a branch or a commit (nothing starting with `-`), and records `--mcp-ref` only after a check:

- `main`: the checkout's `origin` must be `github.com/fal3/wisply-mcp`. `sync-vendor` fetches `origin/main` and needs the commit on `refs/remotes/origin/main`; the checkout's own `main` never counts, since it can hold commits nobody pushed or reviewed. `SOURCE.json` then records `remote` and `remote_main` (the tip it checked against), and the release gate needs both.
- Any other branch (interim snapshots, which the gate refuses anyway): `git merge-base --is-ancestor` against that branch in the checkout.

After you change `src/editor-messages.mjs`, run `node esbuild.mjs --server`. It rebuilds the bundle and records the new sha256.

**Current snapshot (interim, not releasable).** The connector comes from `b086989` on `claude/distribution-3`. That commit is DIST-M2 with its review fixes, merged with DIST-M1's second review:

- `setup` replaces the Keychain item instead of merging access lists (no `-U`).
- `/usr/bin/security` runs without `WISPLY_MCP_*` variables.
- No connector text names the unregistered npm package.
- When Wisply answers the identity check with its own 503 (it couldn't read its tokens from the Keychain), the connector still keeps the token back, and it now says to quit and reopen Wisply instead of reporting a failed identity check. Check Connection shows that text.
- `forget` succeeds off macOS, where nothing can have been saved.

These are the parts of the connector the extension runs: the server, `setup` and the token texts. DIST-M3's tip (`f28a7e1`) has the same `bin/` and `lib/` files byte for byte, so nothing from it is missing. The snapshot doesn't include DIST-M4: the bundle's `print-config` and `install` answer "not in this build", and the extension uses neither. Once M1 to M4 are merged into `wisply-mcp` `main`, re-vendor from `main` with `--mcp-ref main`. Until then the release gate refuses this tree.

Never edit the vendored files or the bundle by hand. `test/vendor.test.mjs` and `test/bundle.test.mjs` fail if you do.

## License

MIT. See `LICENSE`.
