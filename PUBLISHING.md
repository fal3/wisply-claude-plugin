# Publishing Wisply for VS Code

Alex owns the publisher, the tokens and every upload. Agents never publish. This file stays in the repository; it isn't in the `.vsix`.

## Before you publish

Run these at the release tag:

```bash
npm ci
npm run check            # typecheck, tests, build, development package
npm run package:release  # wisply-<version>.vsix, through the release gate
```

`npm run package:release` stops with "Not releasable" until every item in `scripts/release-gate.mjs` is final ([DEVELOPMENT.md](DEVELOPMENT.md), "Packaging and the release gate"). It also stops when the checkout isn't clean or a vendored file, the packaged skill or the bundle isn't what `vendor/SOURCE.json` records, so run it from a fresh clone of the release tag. Before you set `FINAL.support`, send a test mail to support@wisply.ai and check that it arrives: it is the only address in the package, and `SECURITY.md` tells people to report vulnerabilities there. Publish only the `wisply-<version>.vsix` it writes. `wisply-dev.vsix` from `npm run package` is a different extension (`wisply.wisply-dev`, version `0.1.0-dev`). The Marketplace and `vsce publish` refuse its prerelease version, and Open VSX would list it on its own, so it can't replace or use up a release.

## VS Code Marketplace (manual upload, spec D7)

1. Sign in at <https://marketplace.visualstudio.com/manage> as the `wisply` publisher.
2. **New extension > Visual Studio Code**, then upload `wisply-<version>.vsix`. For a later version, use **More Actions > Update** on the extension.
3. Wait until the version shows as verified. The Marketplace scans every upload.

## Open VSX

After the Open VSX account and namespace steps ([G-OPENVSX] in the distribution spec), publish the same file:

```bash
npx ovsx@1.3.0 publish wisply-<version>.vsix -p "$(<password manager read>)"
```

## If a store holds or removes the extension

The bundled connector reads one Keychain item with `/usr/bin/security`, and the extension starts the connector as a child process with `ELECTRON_RUN_AS_NODE=1`. Malware scanners also see that pattern in credential stealers, so a scan hold or a takedown after release is possible.

- **VS Code Marketplace:** sign in at <https://marketplace.visualstudio.com/manage>, click **Contact Microsoft** at the top right, and send the note below.
- **Open VSX:** open an issue in [EclipseFdn/open-vsx.org](https://github.com/EclipseFdn/open-vsx.org/issues) with the same note.
- Meanwhile, the wisply.ai install page keeps the other ways to connect VS Code (the one-click MCP link and the Agent Plugin).

Keep the bundle unminified (`esbuild.mjs` sets `minify: false`) so reviewers can read it.

### Note for store reviewers

Fill in the version and the commits from `vendor/SOURCE.json` (`sources[0].commit` for the connector, `skill.commit` for the skill) before you send it.

> Wisply for VS Code (`wisply.wisply`, version `<version>`) connects the editor's AI chat to the Wisply app on the same Mac. It runs a bundled MCP connector, `server/wisply-mcp.mjs`, with the editor's own Node (`process.execPath` with `ELECTRON_RUN_AS_NODE=1`), so nothing is downloaded at runtime.
>
> The connector touches exactly one Keychain item: generic password, service `ai.wisply.mcp`, account `token`, label "Wisply MCP token". It reads it with `/usr/bin/security find-generic-password -s ai.wisply.mcp -a token -w`, only when the user has stored no token in the editor's secret storage, and a token from there gets only the read-only memo tools. The user creates the item with the extension's "Store Token in the Mac Keychain" command. It opens a terminal that runs the connector's `setup`, which removes an earlier copy (`delete-generic-password`) and creates the item (`add-generic-password ... -T /usr/bin/security -w`, where macOS asks for the token in the terminal), so the token never passes through the extension. No other Keychain item is read or changed.
>
> The extension starts the same connector a second time, as a read-only child process (`--read-only`), for its status bar item, its "Insert Transcript Quote" command and "Check Connection". It starts only when the user runs one of those commands, or for the status bar item after the user has set Wisply up in the editor (a stored token, or a "Check Connection" or quote that reached the app); before that, the extension starts no process and reads no Keychain item. The status bar item asks only while the editor window is focused, at least once a minute, so the process keeps running while the window is focused and the item is on; it stops two minutes after its last use. After three answers in a row without a recording state, the item stops asking until the window is focused again. When the editor's secret storage holds no token, the process reads the Keychain item when it starts, and again on a status check while it has found no usable token there.
>
> The connector connects only to 127.0.0.1, to the Wisply app on the user's Mac, and sends the token only after the app proves it holds the same token (an HMAC over a fresh nonce). It has no other network code, and the extension itself (`dist/extension.js`) has none. Nothing is collected or sent anywhere else.
>
> `skills/wisply-memos/SKILL.md` is a text-only chat skill (`contributes.chatSkills`): instructions for the AI model on how to use the connector's tools safely. It contains no code.
>
> Source: https://github.com/fal3/wisply-vscode (the extension) and https://github.com/fal3/wisply-mcp at commit `<commit>` (the connector and the skill; `vendor/SOURCE.json` in the package records the commits and the sha256 of every vendored file, of the bundle and of the packaged skill).
