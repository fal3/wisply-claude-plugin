// Fixed values of the Wisply connector. Keep this file ASCII.
//
// PACKAGE_NAME and PACKAGE_SPEC are placeholders until Alex publishes the
// package (spec D3: if the npm organization "wisply" is taken, the fallback is
// "wisply-mcp"). Change them here, in package.json and in the manifests
// together; tests/pack.test.mjs fails while they disagree.
import contract from './contract.mjs';

export const PACKAGE_NAME = '@wisply/mcp';
/** What snippets run: the newest 0.x release, so a hijacked major bump never runs on its own. */
export const PACKAGE_SPEC = '@wisply/mcp@0';
/** Equal to package.json "version" (pack.test). Hard-coded so a single-file bundle needs no package.json. */
export const VERSION = '0.1.0';

/** The key every client config uses for this server. */
export const SERVER_KEY = 'wisply';

/** The only host the connector ever talks to. No flag or variable changes it. */
export const HOST = '127.0.0.1';
export const DEFAULT_PORT = contract.default_port;
export const MIN_PORT = 1024;
export const MAX_PORT = 65535;

/** MCP protocol versions the connector's handshake accepts, newest first. */
export const PROTOCOL_VERSIONS = Object.freeze(['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05']);

/** The macOS Keychain item the connector manages (written by `setup`, DIST-M2). */
export const KEYCHAIN_SERVICE = 'ai.wisply.mcp';
export const KEYCHAIN_ACCOUNT = 'token';
export const KEYCHAIN_LABEL = 'Wisply MCP token';
export const SECURITY_BIN = '/usr/bin/security';
/** A token lookup that takes longer than this counts as "no token". */
export const KEYCHAIN_TIMEOUT_MS = 2000;

/** Response budgets: tool results, and the small identity answer. */
export const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
export const MAX_IDENTITY_BYTES = 8 * 1024;

/** Time budgets. Status reads are in memory in Wisply, so they get a short one. */
export const IDENTITY_TIMEOUT_MS = 3000;
export const LIVE_TIMEOUT_MS = 5000;
export const CALL_TIMEOUT_MS = 30000;

/** JSON-RPC error code Wisply returns when a token's scope doesn't allow a tool. */
export const TOOL_NOT_PERMITTED = -32003;

/** The tool hidden unless the user opts in (spec D4; Raycast D21). */
export const CLAUDE_SETUP_TOOL = 'setup_claude';
