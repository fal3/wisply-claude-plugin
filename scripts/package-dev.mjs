#!/usr/bin/env node
// `npm run package`: a development package for local testing and Mac QA,
// built so that no store can take it as this extension.
//
//   node scripts/package-dev.mjs [--out <file>] [--no-build]
//
// vsce packages a copy of the packaged files whose manifest has another
// name ("wisply-dev"), display name ("Wisply (development build)") and a
// prerelease version ("0.1.0-dev"):
//   - `vsce publish --packagePath` refuses any prerelease version ("The VS
//     Marketplace doesn't support prerelease versions"), and so does the
//     Marketplace for an uploaded file;
//   - Open VSX would see a different extension (wisply.wisply-dev), never a
//     version of wisply.wisply, so a slip can't use up 0.1.0 of the real one.
// The copy has no scripts, so vsce runs no vscode:prepublish there: the
// release gate (scripts/release-gate.mjs) stays a gate with no way around
// it, and this script prints what it would refuse instead. A release
// package comes only from `npm run package:release` in the source tree.
//
// --no-build skips rebuilding dist/extension.js (the tests already built it).
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import * as esbuild from 'esbuild';
import { ROOT, SOURCE_FILE, buildServerBundle, extensionOptions } from '../esbuild.mjs';
import { integrityProblems, releaseProblems } from './release-gate.mjs';

export const DEV_PACKAGE_FILE = 'wisply-dev.vsix';
export const DEV_SUFFIX = '-dev';
export const DEV_DISPLAY_SUFFIX = ' (development build)';

/**
 * The development manifest: another name and display name, a prerelease
 * version, and no scripts (so no vscode:prepublish runs in the copy).
 * @param {Record<string, any>} manifest package.json
 */
export function devManifest(manifest) {
  const { scripts: _scripts, devDependencies: _devDependencies, ...kept } = manifest;
  return {
    ...kept,
    name: `${manifest.name}${DEV_SUFFIX}`,
    displayName: `${manifest.displayName}${DEV_DISPLAY_SUFFIX}`,
    version: `${manifest.version}${DEV_SUFFIX}`,
  };
}

/**
 * Builds the development .vsix.
 * @param {{out?: string, build?: boolean, log?: (text: string) => void}} [options]
 * @returns {Promise<string>} the .vsix path
 */
export async function packageDev({ out = join(ROOT, DEV_PACKAGE_FILE), build = true, log = (text) => process.stderr.write(text) } = {}) {
  const require = createRequire(import.meta.url);
  const vsce = require('@vscode/vsce');
  const manifest = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));

  // What the release gate would refuse, except a working tree with changes (a development build comes from one).
  const source = JSON.parse(readFileSync(join(ROOT, SOURCE_FILE), 'utf8'));
  const problems = [
    ...releaseProblems({
      source,
      readme: readFileSync(join(ROOT, 'README.md'), 'utf8'),
      manifest,
      security: readFileSync(join(ROOT, 'SECURITY.md'), 'utf8'),
    }),
    ...await integrityProblems({
      source,
      read: (path) => readFileSync(join(ROOT, path)),
      rebuild: () => buildServerBundle({ write: false }),
      esbuildVersion: require('esbuild/package.json').version,
    }),
  ];
  if (problems.length > 0) {
    log(`Development package (${manifest.publisher}.${manifest.name}${DEV_SUFFIX}), not releasable:\n` +
      problems.map((problem) => `  - ${problem}\n`).join(''));
  }

  if (build) await esbuild.build(extensionOptions());
  // What `vsce package` would put in the release .vsix, from .vscodeignore.
  const files = await vsce.listFiles({ cwd: ROOT, packageManager: vsce.PackageManager.None });

  const staging = mkdtempSync(join(tmpdir(), 'wisply-dev-package-'));
  try {
    for (const file of files) {
      if (file === 'package.json') continue;
      mkdirSync(dirname(join(staging, file)), { recursive: true });
      copyFileSync(join(ROOT, file), join(staging, file));
    }
    copyFileSync(join(ROOT, '.vscodeignore'), join(staging, '.vscodeignore'));
    writeFileSync(join(staging, 'package.json'), `${JSON.stringify(devManifest(manifest), null, 2)}\n`);
    const packagePath = resolve(out);
    await vsce.createVSIX({ cwd: staging, packagePath, dependencies: false });
    return packagePath;
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: { out: { type: 'string' }, 'no-build': { type: 'boolean' } },
    strict: true,
  });
  await packageDev({ ...(values.out ? { out: values.out } : {}), build: !values['no-build'] });
}
