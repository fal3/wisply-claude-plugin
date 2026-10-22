// Fixed values of the Wisply connector. Keep this file ASCII.
//
// PACKAGE_NAME and PACKAGE_SPEC are placeholders until Alex publishes the
// package (spec D3: if the npm organization "wisply" is taken, the fallback is
// "wisply-mcp"). Neither name is registered yet, so nothing public (the
// wisply.ai guide, Wisply's snippets) may print them before the organization
// exists. Change them here, in package.json and in the manifests together;
// tests/pack.test.mjs fails while they disagree.
import contract from './contract.mjs';

export const PACKAGE_NAME = '@wisply/mcp';
/** Equal to package.json "version" (pack.test). Hard-coded so a single-file bundle needs no package.json. */
export const VERSION = '0.1.0';
/**
 * What snippets run: this exact version. npm never changes a published
 * version, so a later publish (a bad one included) runs only after the user
 * changes the version in their app's settings. It follows VERSION, so every
 * snippet built from it moves with each release.
 */
export const PACKAGE_SPEC = `${PACKAGE_NAME}@${VERSION}`;
/**
 * Opt-in only, never the default in a snippet: the newest 0.x release, fetched
 * from npm each time the app starts the connector. It updates on its own, and
 * a bad 0.x publish would run the same way.
 */
export const PACKAGE_RANGE = `${PACKAGE_NAME}@${VERSION.split('.')[0]}`;

/**
 * npx's own flags, before the package, in every snippet and every command
 * people are told to run. npx looks for the package in the folder it starts
 * in (its node_modules) and reads that folder's .npmrc before it asks the
 * registry, and AI apps start the connector in the project that's open. With
 * `--prefix /`, npx resolves from `/` instead, which on macOS is the read-only
 * system volume, so a cloned project can't bring its own @wisply/mcp (or point
 * the @wisply scope at another registry) and have it run with the user's
 * trust in the wisply entry. The user's own ~/.npmrc still applies.
 */
export const NPX_FLAGS = Object.freeze(['-y', '--prefix', '/']);
/** What people type to run a command of this version: `npx -y --prefix / @wisply/mcp@0.1.0`. */
export const NPX_COMMAND = `npx ${[...NPX_FLAGS, PACKAGE_SPEC].join(' ')}`;
/** The token-free stdio entry every client config runs. */
export const STANDARD_ENTRY = Object.freeze({ command: 'npx', args: Object.freeze([...NPX_FLAGS, PACKAGE_SPEC]) });

/**
 * The server's name in the official MCP Registry, also package.json
 * "mcpName" (which the registry reads from the published package to tie the
 * npm package to the entry). A placeholder like PACKAGE_NAME: the registry
 * accepts an ai.wisply/* name only after Alex proves control of wisply.ai
 * (`mcp-publisher login dns --domain wisply.ai` with a TXT record holding the
 * public key, or `login http` with /.well-known/mcp-registry-auth). A
 * published version's package.json can never change, so this is settled
 * before the first publish: if the domain can't be verified, it becomes
 * io.github.fal3/wisply-mcp (GitHub login as fal3, or as an owner if fal3 is
 * an organization), here and in package.json together (tests/pack.test.mjs;
 * docs/release-checks.json records the verification, SECURITY.md item 3).
 */
export const MCP_NAME = 'ai.wisply/local';

/** The key every client config uses for this server. */
export const SERVER_KEY = 'wisply';

/** The only host the connector ever talks to. No flag or variable changes it. */
export const HOST = '127.0.0.1';
export const DEFAULT_PORT = contract.default_port;
export const MIN_PORT = 1024;
export const MAX_PORT = 65535;

/** MCP protocol versions the connector's handshake accepts, newest first. */
export const PROTOCOL_VERSIONS = Object.freeze(['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05']);

/**
 * Commands planned for later 0.x releases and not in this build. The bin
 * answers them with a "not in this build yet" line (exit 1), and no message
 * tells users to run one of them (tests/bridge.test.mjs). DIST-M2 removes
 * setup, status and forget when it adds them; lib/messages.mjs then points at
 * `setup` again, as the spec's error texts do.
 */
export const PLANNED_COMMANDS = Object.freeze(['setup', 'status', 'forget', 'print-config', 'install']);

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
