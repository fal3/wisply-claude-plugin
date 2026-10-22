// The portable "work with my Wisply memos" skill, as this extension ships it.
//
// fal3/wisply-mcp holds the skill (skills/wisply-memos/SKILL.md, Agent
// Skills format). scripts/sync-vendor.mjs copies it byte for byte to
// vendor/skills/wisply-memos/SKILL.md and writes the packaged copy,
// skills/wisply-memos/SKILL.md, which package.json contributes through
// `contributes.chatSkills` (VS Code requires the folder name to equal the
// skill's `name`).
//
// The packaged copy differs from the vendored one in one line: the
// frontmatter's `compatibility`. Upstream it names the npm package
// (@wisply/mcp), which this extension never runs (it bundles the
// connector), which the AI model in chat would read as a way to install
// Wisply, and whose name isn't Wisply's yet. Here it names this extension
// instead. Every other line, the safety rules included, is upstream's.
// test/skill.test.mjs checks that applying editorSkill() to the vendored
// file gives exactly the packaged file.

export const SKILL_NAME = 'wisply-memos';
/** In fal3/wisply-mcp. */
export const SKILL_UPSTREAM = `skills/${SKILL_NAME}/SKILL.md`;
/** The byte-for-byte copy. */
export const SKILL_VENDORED = `vendor/skills/${SKILL_NAME}/SKILL.md`;
/** What the .vsix holds and chatSkills points to. */
export const SKILL_PACKAGED = `skills/${SKILL_NAME}/SKILL.md`;
export const SKILL_OVERLAY = 'compatibility';

export const EDITOR_COMPATIBILITY =
  'compatibility: Needs the Wisply extension for this editor, or another Wisply MCP connector, on the Mac that ' +
  "runs Wisply, with Wisply's MCP server turned on.";

/**
 * The packaged skill: the upstream text with its frontmatter's one
 * `compatibility:` line replaced. Throws when the frontmatter isn't the
 * shape this overlay was written for, so an upstream change gets a review.
 * @param {string} text the upstream SKILL.md
 * @returns {string}
 */
export function editorSkill(text) {
  if (typeof text !== 'string') throw new TypeError('SKILL.md must be text');
  const lines = text.split('\n');
  if (lines[0] !== '---') throw new Error('SKILL.md has no frontmatter');
  const end = lines.indexOf('---', 1);
  if (end < 0) throw new Error('SKILL.md frontmatter is not closed');
  const found = [];
  for (let index = 1; index < end; index += 1) if (lines[index].startsWith(`${SKILL_OVERLAY}:`)) found.push(index);
  if (found.length !== 1) throw new Error(`SKILL.md frontmatter has ${found.length} ${SKILL_OVERLAY} lines, expected 1`);
  if (/^\s/.test(lines[found[0] + 1] ?? '')) throw new Error(`SKILL.md ${SKILL_OVERLAY} spans more than one line`);
  lines[found[0]] = EDITOR_COMPATIBILITY;
  return lines.join('\n');
}
