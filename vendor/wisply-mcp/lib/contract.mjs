// The local MCP surface of Wisply for Mac: tools, token scopes, descriptors.
//
// The data is wisply-ai's Docs/mcp-contract.json, vendored as
// contract/mcp-contract.json and imported through the module that
// scripts/gen-data.mjs generates from it. A static import (not a JSON import
// attribute, not a file read) works on every Node 20 and survives a
// single-file bundle. The connector answers tools/list from these
// descriptors and never from whatever listens on the port.
import data from '../contract/mcp-contract.mjs';
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

const deepFreeze = (value) => {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
};

// Checked once, when the connector loads. A broken contract is a packaging
// error, so it stops the process before any client sees a tool.
const problems = contractProblems(data);
if (problems.length > 0) {
  throw new Error(`Wisply connector contract is invalid: ${problems.join(', ')}`);
}

/** The whole contract, deep-frozen. */
const contract = deepFreeze(data);
export default contract;

export const tools = contract.tools;
export const scopes = contract.scopes;
export const defaultPort = contract.default_port;
export const descriptors = contract.tool_descriptors;
const byName = new Map(contract.tool_descriptors.map((descriptor) => [descriptor.name, descriptor]));

/**
 * The MCP descriptor (name, title, description, inputSchema, annotations) of a contract tool.
 * @param {string} name
 */
export function descriptorFor(name) {
  return byName.get(name);
}
