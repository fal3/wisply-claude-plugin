// The shape a Wisply contract must have before the connector uses it.
//
// No side effects and no data: lib/contract.mjs checks the vendored contract
// with it when the connector loads (and throws on a broken one), and
// scripts/sync-vendor.mjs checks wisply-ai's file with it before writing
// anything, which it can do even when the vendored copy is broken.
import { IDENTITY_SCHEME } from './identity.mjs';

export const CONTRACT_SCHEMA = 'wisply-mcp-contract-v1';
const SCOPES = ['full', 'connector', 'recording'];

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const isNameList = (value) => Array.isArray(value) && value.every((name) => typeof name === 'string' && name !== '');

/**
 * Problems with a contract's shape, as short ASCII strings; empty when it's usable.
 * @param {unknown} contract
 * @returns {string[]}
 */
export function contractProblems(contract) {
  if (!isObject(contract)) return ['contract is not an object'];
  const problems = [];
  if (contract.schema !== CONTRACT_SCHEMA) problems.push('schema');
  if (contract.identity_scheme !== IDENTITY_SCHEME) problems.push('identity_scheme');
  const port = contract.default_port;
  if (!Number.isInteger(port) || port < 1024 || port > 65535) problems.push('default_port');
  if (!isNameList(contract.tools) || new Set(contract.tools).size !== contract.tools.length) {
    return [...problems, 'tools'];
  }
  const known = new Set(contract.tools);
  if (!isObject(contract.scopes)) return [...problems, 'scopes'];
  for (const scope of SCOPES) {
    const entry = contract.scopes[scope];
    if (!isObject(entry) || typeof entry.prefix !== 'string' || !isNameList(entry.tools) ||
        !entry.tools.every((tool) => known.has(tool))) {
      problems.push(`scopes.${scope}`);
    }
  }
  const descriptors = contract.tool_descriptors;
  if (!Array.isArray(descriptors) || descriptors.length !== contract.tools.length) {
    return [...problems, 'tool_descriptors'];
  }
  descriptors.forEach((descriptor, index) => {
    const ok = isObject(descriptor) && descriptor.name === contract.tools[index] &&
      typeof descriptor.title === 'string' && typeof descriptor.description === 'string' &&
      isObject(descriptor.inputSchema) && descriptor.inputSchema.type === 'object' &&
      isObject(descriptor.annotations);
    if (!ok) problems.push(`tool_descriptors[${index}]`);
  });
  return problems;
}
