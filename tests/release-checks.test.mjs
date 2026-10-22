// Release checks that no file in this repository can prove by itself, so a
// maintainer records them in docs/release-checks.json (not shipped), and
// `WISPLY_RELEASE=1 npm test` refuses to pass until they are recorded:
//
// - port_exclusive: the token's safety assumes Wisply alone listens on its
//   port while it runs, and MCPServer.swift sets allowLocalEndpointReuse =
//   true, which may let a second same-user socket bind 127.0.0.1:51771 next
//   to Wisply (SECURITY.md, "The identity check"). Recorded for the Wisply
//   commit the contract is vendored from, so a re-vendor asks again: either
//   that commit binds exclusively, or a test on a Mac showed a second bind
//   fails while Wisply runs.
// - registry_namespace: package.json "mcpName" (MCP_NAME) is a name the
//   official MCP Registry accepts only after its namespace is verified (DNS
//   or HTTP for ai.wisply/*, GitHub for io.github.<owner>/*), and a
//   published version can't change it.
//
// The contract's own release requirement sits here too: setup_claude, which
// replaces the Anthropic key stored in Wisply's Keychain, must be marked
// destructive before a store or directory reads the descriptors.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import contract from '../lib/contract.mjs';
import { CLAUDE_SETUP_TOOL, MCP_NAME } from '../lib/constants.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const readJson = (path) => JSON.parse(readFileSync(join(ROOT, path), 'utf8'));
const CHECKS_FILE = 'docs/release-checks.json';
const tree = () => ({
  checks: readJson(CHECKS_FILE), source: readJson('contract/SOURCE.json'), pkg: readJson('package.json'), contract, mcpName: MCP_NAME,
});

const isText = (value) => typeof value === 'string' && value.trim().length >= 10;
/** How a namespace may be verified: GitHub for io.github.*, DNS or HTTP on the domain otherwise. */
const methodsFor = (name) => (name.startsWith('io.github.') ? ['github'] : ['dns', 'http']);

/**
 * What still stands between this tree and a release, as messages; [] when nothing does.
 * @param {{checks: any, source: any, pkg: any, contract: any, mcpName: string}} input
 * @returns {string[]}
 */
function releaseCheckProblems({ checks, source, pkg, contract: data, mcpName }) {
  const problems = [];
  const appCommit = source?.sources?.find((entry) => entry.repository === 'github:fal3/wisply-ai')?.commit;
  const port = checks?.port_exclusive ?? {};
  if (port.verified !== true || !isText(port.how)) {
    problems.push(`${CHECKS_FILE}: port_exclusive isn't recorded: show on a Mac that no second socket can listen on ` +
      "Wisply's port while Wisply runs (or that Wisply binds it exclusively), then set verified, wisply_commit and how");
  } else if (!/^[0-9a-f]{40}$/.test(String(appCommit)) || port.wisply_commit !== appCommit) {
    problems.push(`${CHECKS_FILE}: port_exclusive was recorded for ${port.wisply_commit}, not for the vendored ` +
      `contract's Wisply commit (${appCommit}): check that commit again`);
  }
  const namespace = checks?.registry_namespace ?? {};
  if (namespace.name !== mcpName || pkg?.mcpName !== mcpName) {
    problems.push(`${CHECKS_FILE}: registry_namespace.name, package.json "mcpName" and MCP_NAME must agree`);
  }
  const method = /^([a-z]+):/.exec(String(namespace.how))?.[1];
  if (namespace.verified !== true || !isText(namespace.how) || !methodsFor(String(namespace.name)).includes(method)) {
    problems.push(`${CHECKS_FILE}: registry_namespace isn't verified: ${String(namespace.name).startsWith('io.github.')
      ? 'mcp-publisher login github as the owner' : 'mcp-publisher login dns (or http) for the domain'}, then set ` +
      `verified and how ("${methodsFor(String(namespace.name)).join('|')}: <date and evidence>")`);
  }
  const claude = data?.tool_descriptors?.find((descriptor) => descriptor.name === CLAUDE_SETUP_TOOL);
  if (claude?.annotations?.destructiveHint !== true) {
    problems.push(`contract: ${CLAUDE_SETUP_TOOL} must have destructiveHint: true (it replaces the stored Anthropic key): ` +
      'fix MCPToolCatalog.swift in wisply-ai and re-vendor; never edit the vendored JSON');
  }
  return problems;
}

test('docs/release-checks.json has its shape, and names the MCP_NAME package.json has', () => {
  const { checks, pkg } = tree();
  assert.deepEqual(Object.keys(checks), ['schema', 'port_exclusive', 'registry_namespace']);
  assert.equal(checks.schema, 'wisply-mcp-release-checks-v1');
  for (const key of ['port_exclusive', 'registry_namespace']) {
    assert.equal(typeof checks[key].verified, 'boolean', key);
    assert.ok(checks[key].how === null || typeof checks[key].how === 'string', key);
  }
  assert.ok(checks.port_exclusive.wisply_commit === null || /^[0-9a-f]{40}$/.test(checks.port_exclusive.wisply_commit));
  assert.equal(checks.registry_namespace.name, MCP_NAME);
  assert.equal(pkg.mcpName, MCP_NAME);
  assert.match(MCP_NAME, /^(ai\.wisply\/[a-z0-9-]+|io\.github\.fal3\/[a-z0-9-]+)$/);
});

test('this tree passes the release checks (WISPLY_RELEASE=1)', { skip: process.env.WISPLY_RELEASE === '1' ? false : 'WISPLY_RELEASE is not 1' }, () => {
  const problems = releaseCheckProblems(tree());
  assert.deepEqual(problems, [], `not releasable:\n- ${problems.join('\n- ')}`);
});

test('the release checks fail on this tree exactly while something is missing', { skip: process.env.WISPLY_RELEASE === '1' }, () => {
  const env = { ...process.env, WISPLY_RELEASE: '1' };
  delete env.NODE_TEST_CONTEXT;
  const problems = releaseCheckProblems(tree());
  const result = spawnSync(process.execPath, ['--test', fileURLToPath(import.meta.url)], { cwd: ROOT, env, encoding: 'utf8' });
  assert.equal(result.status === 0, problems.length === 0, result.stdout.slice(-3000));
  for (const problem of problems) assert.ok(result.stdout.includes(problem.slice(0, 50)), `the failure names: ${problem}`);
});

test('releaseCheckProblems: a releasable tree passes, and each missing check is named', () => {
  const commit = 'a'.repeat(40);
  const descriptors = contract.tool_descriptors.map((descriptor) => (descriptor.name === CLAUDE_SETUP_TOOL
    ? { ...descriptor, annotations: { ...descriptor.annotations, destructiveHint: true } } : descriptor));
  const good = {
    checks: {
      schema: 'wisply-mcp-release-checks-v1',
      port_exclusive: { verified: true, wisply_commit: commit, how: 'MCPServer.swift binds with allowLocalEndpointReuse = false' },
      registry_namespace: { name: 'ai.wisply/local', verified: true, how: 'dns: TXT on wisply.ai, mcp-publisher login dns on 2026-11-02' },
    },
    source: { sources: [{ repository: 'github:fal3/wisply-ai', commit }] },
    pkg: { mcpName: 'ai.wisply/local' },
    contract: { tool_descriptors: descriptors },
    mcpName: 'ai.wisply/local',
  };
  assert.deepEqual(releaseCheckProblems(good), []);
  const github = { name: 'io.github.fal3/wisply-mcp', verified: true, how: 'github: mcp-publisher login github as fal3' };
  assert.deepEqual(releaseCheckProblems({ ...good, checks: { ...good.checks, registry_namespace: github },
    pkg: { mcpName: github.name }, mcpName: github.name }), []);

  const changed = (key, change) => ({ ...good, checks: { ...good.checks, [key]: { ...good.checks[key], ...change } } });
  const cases = [
    [changed('port_exclusive', { verified: false }), /port_exclusive isn't recorded/],
    [changed('port_exclusive', { how: '' }), /port_exclusive isn't recorded/],
    [changed('port_exclusive', { wisply_commit: 'b'.repeat(40) }), /recorded for b{40}, not for the vendored contract's Wisply commit/],
    [{ ...good, source: { sources: [{ repository: 'github:fal3/wisply-ai', commit: '885cc75 (transcribed)' }] } }, /not for the vendored/],
    [changed('registry_namespace', { verified: false }), /registry_namespace isn't verified: mcp-publisher login dns/],
    [changed('registry_namespace', { how: 'github: logged in as fal3' }), /registry_namespace isn't verified/],
    [{ ...good, pkg: { mcpName: 'io.github.fal3/wisply-mcp' } }, /must agree/],
    [{ ...good, contract }, /setup_claude must have destructiveHint: true/],
  ];
  for (const [input, expected] of cases) {
    const problems = releaseCheckProblems(input);
    assert.equal(problems.length, 1, problems.join(' | '));
    assert.match(problems[0], expected);
  }
  // Today's tree: all three are missing, and the contract still marks setup_claude non-destructive.
  assert.equal(releaseCheckProblems(tree()).length, 3);
});
