// The local MCP surface of Wisply for Mac: tools, token scopes, descriptors.
//
// The data is wisply-ai's Docs/mcp-contract.json, vendored as
// contract/mcp-contract.json and imported through the module that
// scripts/gen-data.mjs generates from it. A static import (not a JSON import
// attribute, not a file read) works on every Node 20 and survives a
// single-file bundle. The connector answers tools/list from these
// descriptors and never from whatever listens on the port.
import data from '../contract/mcp-contract.mjs';
import { contractProblems } from './contract-shape.mjs';

export { CONTRACT_SCHEMA, contractProblems } from './contract-shape.mjs';

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
