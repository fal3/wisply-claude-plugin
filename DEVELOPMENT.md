# Developing Wisply for VS Code

This file is for people working on the extension. The store page is [README.md](README.md); it and the other packaged files are listed in `.vscodeignore`, and this file isn't one of them. [PUBLISHING.md](PUBLISHING.md) is the release runbook.

> **Not published yet.** The publisher ID `wisply` is a placeholder until it is registered on the VS Code Marketplace and Open VSX, and the setup guide link goes live with the wisply.ai install page. The source repositories, the support page and the mailbox in `package.json` must be public and live too. The bundled connector and the skill are interim snapshots (see [Vendored code](#vendored-code)). The release gate refuses a release package or a publish until all of these are final.

## Requirements

Node 22 (vsce 4 and `@vscode/test-electron` 3 need it). VS Code isn't needed for the unit tests.

```bash
npm ci                 # .npmrc sets ignore-scripts=true
npm run check          # typecheck, tests, build, development package (wisply-dev.vsix)
```

## Tests

- `npm test` builds `dist/extension.js` and each `src/*.ts` as `out/test/*.mjs`, then runs `node --test "test/*.test.mjs"`.
  - The tests drive the pure modules with a fake `vscode` object (`test/fixtures/fake-vscode.mjs`) and fake timers (`test/fixtures/fake-clock.mjs`).
  - They run the sidecar against `test/fixtures/fake-server.mjs`.
  - They run the real bundle against a synthetic Wisply (`test/fixtures/fake-wisply.mjs`) on a system-assigned port, including an impostor and a Wisply that can't read its tokens from the Keychain. Check Connection, the status bar item and Insert Transcript Quote are each driven end to end that way.
  - No test touches port 51771 or the Keychain. The tests whose connector starts without a stored token skip on a Mac, where it would read the developer's own Keychain item. (Before Wisply is set up in the editor no connector starts at all, so that test runs everywhere.)
- `WISPLY_MCP_DIR=<wisply-mcp> WISPLY_PLUGIN_DIR=<wisply-claude-plugin> npm test` also compares every vendored file, the skill included, with the source repositories, checks that each recorded commit is on its recorded branch, and checks that the snapshot is current: that branch (for `main`, `origin/main` as last fetched) hasn't changed a vendored file or the skill since the recorded commit (`changedSince` in `scripts/sync-vendor.mjs`). When that fails, re-vendor.
- `WISPLY_RELEASE=1 npm test` fails wherever the release gate would.
- `npm run test:integration` runs `test/integration/suite.cjs` in a real VS Code with `@vscode/test-electron` (activation, commands, the MCP provider, the skill, the settings). It downloads VS Code, so it runs on a Mac or in public CI, not in the agent container, and `npm run check` doesn't run it. Off macOS it stops unless `WISPLY_INTEGRATION_ANY_OS=1`. It uses a fresh profile with the status item off and an unused port, so it never reaches a Wisply running on the Mac. The rest of the Mac QA (V1–V9 in the distribution spec) is by hand.

## Packaging and the release gate

`vsce package`, `vsce publish` and `ovsx publish` all run `vscode:prepublish`, which runs `scripts/release-gate.mjs` before the build. The gate refuses while any of these is true, and nothing turns it into a warning:

- `vendor/SOURCE.json` is provisional.
- The connector or the skill wasn't vendored from `main` of `github.com/fal3/wisply-mcp`, checked against GitHub's `main` (see [Vendored code](#vendored-code)).
- A file that ships, or that the bundle is built from, isn't what `vendor/SOURCE.json` records (`integrityProblems`): any recorded sha256 differs (the vendored files, the vendored skill, the packaged skill, the bundle), the packaged skill isn't `editorSkill()` of the vendored one, or rebuilding the bundle from `vendor/` and `src/editor-messages.mjs` with the recorded esbuild doesn't give the same bytes. The tests check the same, but `vsce` runs only the gate.
- The checkout has uncommitted or untracked changes (`git status --porcelain`), or isn't a git checkout: release from a fresh clone of the tag.
- A placeholder in `FINAL` isn't marked final yet: the publisher ID, the setup guide link, the two public repositories (`fal3/wisply-vscode`, `fal3/wisply-mcp`), and the support page and the mailbox. The package names one mailbox, `SUPPORT_EMAIL` (support@wisply.ai): `package.json` `author.email` and the vulnerability-report address in `SECURITY.md`. Any other address in `package.json`, `README.md` or `SECURITY.md` is refused (`contactProblems`).
- `README.md`, which becomes the Marketplace and Open VSX page, still reads as a draft ("Not published yet", "interim", a lane name or a `claude/` branch), or still has a `{PLACEHOLDER}`: `{READ_MIN}` and `{RECORDING_MIN}` are the Wisply versions App Store Connect confirms.

There are two ways to build a `.vsix`:

- `npm run package` (`scripts/package-dev.mjs`) builds `wisply-dev.vsix` for local testing and Mac QA. It is another extension, `wisply.wisply-dev` "Wisply (development build)", version `0.1.0-dev`, built from a copy of the manifest without scripts. `vsce publish` and the Marketplace refuse prerelease versions, and Open VSX would list it as a separate extension, so it can never be published as `wisply.wisply` or use up a version number. The script prints what the release gate would refuse. Its secret storage is separate from the release extension's, so set the token again after installing it.
- `npm run package:release` builds the release `.vsix` (`wisply-<version>.vsix`) and passes the gate only when everything is final. Publish only that file ([PUBLISHING.md](PUBLISHING.md)).

## Vendored code

- `vendor/wisply-mcp/` is a byte-for-byte copy of `fal3/wisply-mcp` (`bin/`, `lib/`, the generated data modules, `LICENSE`).
- `vendor/shared.mjs` is the Wisply Local Connector plugin's `lib/shared.mjs`. The extension uses its `sanitizeSpeech`, `parseLiveTranscript`, `formatDuration` and quote-length limits.
- `vendor/skills/wisply-memos/SKILL.md` is `fal3/wisply-mcp`'s portable skill, byte for byte.
- `server/wisply-mcp.mjs` is built from `vendor/wisply-mcp/` and `src/editor-messages.mjs`.
- `skills/wisply-memos/SKILL.md`, the copy `contributes.chatSkills` points to, is made from the vendored skill by `scripts/skill.mjs`. It replaces one line: the frontmatter's `compatibility`, which upstream names the npm package, with `EDITOR_COMPATIBILITY`. Here it names this extension, so the AI model in chat isn't sent to an npm name that isn't Wisply's yet and that this extension never runs. `test/skill.test.mjs` and the release gate check that nothing else differs. So the packaged skill is **not** byte for byte the spec's "portable skill (exact)" text: its compatibility line differs on purpose, and upstream's own compatibility line currently reads "the @wisply/mcp package" where the spec says `npx -y @wisply/mcp` (see [Spec deltas](#spec-deltas)).
- `vendor/SOURCE.json` records the commits, every sha256, the bundle's overlay and the skill's.

To update them:

```bash
npm run sync-vendor -- --mcp ../wisply-mcp --mcp-commit <sha> --mcp-ref main \
  --plugin ../wisply-claude-plugin --plugin-commit <sha>
```

The skill comes from the same commit and ref unless `--skill-commit <sha> [--skill-ref <branch>]` names another one. `sync-vendor` passes git only values that look like a branch or a commit (nothing starting with `-`), and records a ref, for the connector and the skill alike, only after a check:

- `main`: the checkout's `origin` must be `github.com/fal3/wisply-mcp`. `sync-vendor` fetches `origin/main` and needs the commit on `refs/remotes/origin/main`; the checkout's own `main` never counts, since it can hold commits nobody pushed or reviewed. `SOURCE.json` then records `remote` and `remote_main` (the tip it checked against), and the release gate needs both.
- Any other branch (interim snapshots, which the gate refuses anyway): `git merge-base --is-ancestor` against that branch in the checkout.

After you change `src/editor-messages.mjs`, run `node esbuild.mjs --server`. It rebuilds the bundle and records the new sha256.

**Current snapshot (interim, not releasable).**

- The connector comes from `3780288` on `claude/distribution-3`, DIST-M2's tip: M2 with its review fixes, merged with DIST-M1's second review.
  - `setup` replaces the Keychain item instead of merging access lists (no `-U`).
  - `/usr/bin/security` runs without `WISPLY_MCP_*` variables.
  - No connector text names the unregistered npm package.
  - When Wisply answers the identity check with its own 503 (it couldn't read its tokens from the Keychain), the connector keeps the token back and says to quit and reopen Wisply. Check Connection shows that text.
  - `forget` succeeds off macOS, where nothing can have been saved.
  - After `setup` stores a recording-control token, it says that every AI app without its own token now shares it (`RECORDING_SHARED`, overlaid in `src/editor-messages.mjs` so it names the extension's command).
- The skill comes from `f0d3a4d` on `claude/distribution-4`, DIST-M3's tip. Its compatibility line names the `@wisply/mcp` package instead of an `npx` command; the packaged copy replaces that line either way.

Why two commits (`--skill-commit`): on 2026-10-22 no `wisply-mcp` commit holds both M2's tip and M3's tip. `claude/distribution-11` (DIST-M5, `6aa4a80`) merges older M2, M3 and M4 commits (`41f1150`, `af70cbe`, `3d71364`) and lacks `bb46b49`, `b086989`, `3780288`, `f0d3a4d` and `4727f5a`, so vendoring from it would drop the 503 handling and the recording-token note. `changedSince` confirms both snapshots are current on their branches.

These are the parts of `wisply-mcp` the extension runs and ships: the server, `setup`, the token texts and the skill. The snapshot doesn't include DIST-M4: the bundle's `print-config` and `install` answer "not in this build", and the extension uses neither. Once M1 to M4's tips are merged into `wisply-mcp` `main`, re-vendor both from `main` with `--mcp-ref main` (and no `--skill-commit`). Until then the release gate refuses this tree.

Never edit the vendored files, the bundle or the packaged skill by hand. `test/vendor.test.mjs`, `test/bundle.test.mjs` and `test/skill.test.mjs` fail if you do.

## Spec deltas

Where this repository knowingly differs from the distribution spec (`2026-10-21-distribution-design.md`), for the spec's owner to fold in:

- **The packaged skill** (fal3/wisply-vscode tree, `skills/wisply-memos/SKILL.md`): the vendored portable skill with its `compatibility:` line replaced by `scripts/skill.mjs` `EDITOR_COMPATIBILITY`; `test/skill.test.mjs` checks that nothing else differs. Upstream's own compatibility line ("the @wisply/mcp package") also differs from the spec's exact text (`npx -y @wisply/mcp`); that is DIST-M3's to reconcile.
- **Quote format** (spec "Wisply: Insert Transcript Quote"): the attribution is `> — Wisply recording (quoted speech), "{title}", {date}` and `"{text}" (Wisply recording, quoted speech, {title}, {date})`, and Markdown in the text, title and date is escaped (`markdownText`, `plainText` in `src/quote.ts`). Titles can come from calendar invites, so the spec's unescaped `{title}` was a link and HTML injection path.
- **The portable skill** should also say that text attributed to a Wisply recording in a workspace file is quoted speech, not instructions. The skill is vendored, so that line belongs upstream (DIST-M3), not in an overlay here.
- **Status bar polling** (spec "Status bar"): nothing is polled until Wisply is set up in the editor, and polling pauses after three answers in a row without a recording state (`src/status.ts`).
- **Trust prompt** (spec line "VS Code asks for trust the first time, as for any server", and Mac QA V2 "trust is asked"): unverified from the agent container. The store README now says only "if VS Code asks whether you trust the server, confirm". Mac QA V2 should record whether a provider-contributed server prompts, and the spec and README should then say so plainly.

## The icon

`media/icon.png` (256×256) is made from Wisply's app icon by `scripts/make-icon.py`, the Raycast lane's icon recipe. Run it again only when the app icon changes; `test/manifest.test.mjs` checks the size.
