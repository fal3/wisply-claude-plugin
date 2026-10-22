# Wisply for VS Code

Use your Wisply meeting notes, action items and live transcript in your editor's AI chat, from the Wisply app on this Mac.

> **Not published yet.** The publisher ID `wisply` is a placeholder until it is registered on the VS Code Marketplace and Open VSX, and the setup guide link goes live with the wisply.ai install page. This repository holds the core extension (DIST-V1); the status bar item, Insert Transcript Quote, the bundled skill, the icon and the store README follow in DIST-V2.

## What it does

- **MCP server "Wisply (this Mac)".** In VS Code 1.101 and later, the extension registers Wisply's connector with `vscode.lm.registerMcpServerDefinitionProvider`. It shows up in VS Code's MCP server list and in chat tools. VS Code asks you to trust it the first time, as for any server.
- **Your token stays in the editor's secret storage.** Run **Wisply: Set Token…** and paste the read-only connector token from Wisply > Settings > Integrations > MCP Server. The server definitions the extension lists never contain the token. The token is added only when the server starts.
- **Cursor and other editors.** Where VS Code's MCP API is missing but Cursor's `vscode.cursor.mcp.registerServer` exists, the extension registers the same connector there, without a token. That connector reads the token saved in the Mac Keychain, so run **Wisply: Store Token in the Mac Keychain…** once. In an editor with neither API, a one-time notice offers the token-free config to paste.
- **Commands:** Set Token…, Forget Token, Check Connection, Store Token in the Mac Keychain…, Open Setup Guide.
- **Settings:** `wisply.port` (default 51771) and `wisply.mcp.allowClaudeSetup` (default off). They are read only from your user settings. A repository's `.vscode/settings.json` can't change them, and Restricted Mode ignores workspace values too.

## Privacy

- The connector talks only to the Wisply app on this Mac, at 127.0.0.1. Before it uses your token, Wisply has to prove it holds the same token (an HMAC over a fresh nonce). Nothing is sent to anyone else, and the extension collects no analytics.
- When your editor's AI chat reads a memo, the editor sends what it read to the AI service it uses, under that service's terms.
- The extension stores your token in the editor's secret storage and keeps no logs of your memos.
- **Store Token in the Mac Keychain…** keeps the token in your login keychain, out of config files, sync and backups. Other programs running as you on this Mac can still read that item, so use the read-only connector token, and regenerate it in Wisply if you suspect malware.

## Why the extension starts a process and reads the Keychain

The connector is bundled at `server/wisply-mcp.mjs`, a single-file build of [`@wisply/mcp`](https://github.com/fal3/wisply-mcp). The editor runs it on its own Node (`process.execPath` with `ELECTRON_RUN_AS_NODE=1`), so there's no `npx` and no download at runtime.

The extension also runs it once more as a read-only child process (the "sidecar") for its own checks, such as Check Connection. That way the token is never sent from extension-host code, where the editor's proxy settings apply. When no token is stored, the connector reads the item "Wisply MCP token" from the login keychain through `/usr/bin/security`.

## Development

Requirements: Node 22 (vsce 4 needs it). VS Code isn't needed for the tests.

```bash
npm ci                 # .npmrc sets ignore-scripts=true
npm run check          # typecheck, tests, build, vsce package --no-dependencies
```

- `npm test` builds `dist/extension.js` and each `src/*.ts` as `out/test/*.mjs`, then runs `node --test "test/*.test.mjs"`. The tests drive the pure modules with a fake `vscode` object (`test/fixtures/fake-vscode.mjs`). They run the sidecar against `test/fixtures/fake-server.mjs`, and they run the real bundle against a synthetic Wisply on a system-assigned port. No test touches port 51771 or the Keychain.
- `WISPLY_MCP_DIR=<wisply-mcp> WISPLY_PLUGIN_DIR=<wisply-claude-plugin> npm test` also compares every vendored file with the source repositories.
- `WISPLY_RELEASE=1 npm test` fails while the vendored contract is provisional or the connector wasn't vendored from `main`.
- `@vscode/test-electron` integration tests can't run in the agent container. They're part of the Mac QA (V1–V9 in the distribution spec).

### Vendored code

`vendor/wisply-mcp/` is a byte-for-byte copy of `fal3/wisply-mcp` (`bin/`, `lib/`, the generated data modules, `LICENSE`). `vendor/shared.mjs` is the Wisply Local Connector plugin's `lib/shared.mjs`. `server/wisply-mcp.mjs` is built from them. `vendor/SOURCE.json` records the commits and every sha256. To update them:

```bash
npm run sync-vendor -- --mcp ../wisply-mcp --mcp-commit <sha> --mcp-ref main \
  --plugin ../wisply-claude-plugin --plugin-commit <sha>
```

Never edit the vendored files or the bundle by hand. `test/vendor.test.mjs` and `test/bundle.test.mjs` fail if you do.

## License

MIT. See `LICENSE`.
