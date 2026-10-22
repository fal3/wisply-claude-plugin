// What the release change itself must do, one of the three checks behind
// `WISPLY_RELEASE=1 npm test` (Alex's local release check, and the release
// workflow before it stages a version). The other two are
// tests/vendor.test.mjs (the contract isn't provisional) and
// tests/release-checks.test.mjs (what a maintainer records in
// docs/release-checks.json, PACKAGE_NAME_FINAL with no "private", a
// destructive setup_claude); tests/clients.test.mjs requires "published":
// true. So each missing step is named once. Pure, so
// tests/release.test.mjs can check the rules on made-up trees as well as on
// this one.

/** The CHANGELOG headings a version may have: dated once it is released, "Unreleased" until then. */
export const changelogHeading = /^## (\d+\.\d+\.\d+) - (Unreleased|\d{4}-\d{2}-\d{2})$/;

/** A real calendar date, YYYY-MM-DD. */
export function isDate(text) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return false;
  const date = new Date(`${text}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === text;
}

/**
 * The first version section of a CHANGELOG.
 * @param {string} text
 * @returns {{version: string, date: string, body: string} | {problem: string}}
 */
export function topSection(text) {
  const lines = text.split('\n');
  const first = lines.findIndex((line) => line.startsWith('## '));
  if (first < 0) return { problem: 'CHANGELOG.md has no version section' };
  const match = changelogHeading.exec(lines[first]);
  if (!match) {
    return { problem: `CHANGELOG.md: the first section must be "## <version> - Unreleased" or "## <version> - <YYYY-MM-DD>", not "${lines[first]}"` };
  }
  const next = lines.findIndex((line, index) => index > first && line.startsWith('## '));
  return { version: match[1], date: match[2], body: lines.slice(first + 1, next < 0 ? undefined : next).join('\n') };
}

/**
 * Why this tree can't be released as `version`, or [] when it can.
 * @param {{
 *   version: string,
 *   pkg: {version?: string},
 *   clients: {package_spec?: string},
 *   changelog: string,
 *   env?: Record<string, string|undefined>,
 * }} tree
 * @returns {string[]}
 */
export function releaseProblems({ version, pkg, clients, changelog, env = {} }) {
  const problems = [];
  if (pkg.version !== version) problems.push(`package.json is ${pkg.version}, lib/constants.mjs VERSION is ${version}`);
  if (clients.package_spec !== undefined && !clients.package_spec.endsWith(`@${version}`)) {
    problems.push(`clients/mcp-clients.json package_spec is ${clients.package_spec}, not this version`);
  }

  const section = topSection(changelog);
  if ('problem' in section) {
    problems.push(section.problem);
  } else {
    if (section.version !== version) problems.push(`CHANGELOG.md's first section is ${section.version}, not ${version}`);
    if (!isDate(section.date)) problems.push(`CHANGELOG.md: give "## ${section.version}" its release date (YYYY-MM-DD), not "${section.date}"`);
    // The known-limitations item that the re-vendor removes ("The contract is provisional (...)").
    if (/\bcontract is provisional\b/i.test(section.body)) problems.push(`CHANGELOG.md: the ${section.version} section still says the contract is provisional`);
  }

  // In GitHub Actions (the release workflow), the run must be for the tag v<version>.
  if (env.GITHUB_ACTIONS === 'true' || env.GITHUB_REF_TYPE !== undefined) {
    if (env.GITHUB_REF_TYPE !== 'tag' || env.GITHUB_REF_NAME !== `v${version}`) {
      problems.push(`the release workflow must run for tag v${version}, not ${env.GITHUB_REF_TYPE ?? '?'} ${env.GITHUB_REF_NAME ?? '?'}`);
    }
  }
  return problems;
}
