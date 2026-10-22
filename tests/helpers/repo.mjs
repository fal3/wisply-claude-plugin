// Shared reads for the manifest, registry and skill tests.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = fileURLToPath(new URL('../..', import.meta.url));
export const readText = (path) => readFileSync(join(ROOT, path), 'utf8');
export const readJson = (path) => JSON.parse(readText(path));
export const exists = (path) => existsSync(join(ROOT, path));

/** Canonical JSON text: two-space indent and a final newline, as scripts/cloud-entry.mjs (DIST-M6) writes. */
export const jsonText = (value) => `${JSON.stringify(value, null, 2)}\n`;

/** Anything that could be a Wisply token or an auth header. */
export const SECRET_LIKE = /wsp[cr]?_[0-9a-f]{64}|\bBearer\b|\bAuthorization\b/;

/** Width and height from a PNG's IHDR chunk, or null if it isn't a PNG. */
export function pngSize(buffer) {
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (buffer.length < 24 || !signature.every((byte, i) => buffer[i] === byte)) return null;
  if (buffer.toString('ascii', 12, 16) !== 'IHDR') return null;
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

/** Lowercase, hyphenated keywords (Agent Plugins listings, github/awesome-copilot's validation). */
export const KEYWORD_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
