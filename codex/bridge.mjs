// Codex entry point for the read-only Wisply bridge (codex/mcp.json starts it).
//
// It runs the same handler as the Claude Code server (../bridge.mjs): the
// same four read-only tools, fixed loopback endpoint, identity check and
// limits. Two things differ. The token comes from the login Keychain
// (./keychain.mjs), read only when a Wisply tool runs, never from the
// environment or a config file. And the tool errors give Codex's setup
// steps instead of Claude Code's.
import {pathToFileURL} from 'node:url';
import {serve} from '../bridge.mjs';
import {IDENTITY_MARKER, SETUP_MARKER} from '../lib/shared.mjs';
import {KEYCHAIN_SAVE_COMMAND, readKeychainToken} from './keychain.mjs';

// The command is quoted in backticks so that no punctuation after it is
// copied with it: a "." after -w would be saved as the password.
export const CODEX_SETUP_MESSAGE =
  `${SETUP_MARKER} is not set or not valid. In Wisply on this Mac, copy the connector token from ` +
  `Settings > Integrations > MCP Server. Then run \`${KEYCHAIN_SAVE_COMMAND}\` in Terminal and paste ` +
  "the token twice when it asks. Then ask again; Codex doesn't need a restart.";
export const CODEX_NOT_WISPLY_MESSAGE =
  `${IDENTITY_MARKER} failed: the program on 127.0.0.1:51771 could not prove it is the Wisply that issued ` +
  'the token saved in your Keychain, so the token was not sent. If Wisply is running, its token may have been ' +
  'regenerated: copy it again from Wisply Settings > Integrations > MCP Server and save it with ' +
  `\`${KEYCHAIN_SAVE_COMMAND}\` in Terminal. Otherwise quit whatever is using that port, or update Wisply.`;
export const CODEX_SCOPE_MESSAGE =
  'This Wisply tool needs a full-access token, and the token saved in your Keychain does not allow it. ' +
  'Check that Wisply and this plugin are up to date.';

export const CODEX_MESSAGES = Object.freeze({
  setup: CODEX_SETUP_MESSAGE,
  notWisply: CODEX_NOT_WISPLY_MESSAGE,
  scope: CODEX_SCOPE_MESSAGE,
});

/**
 * The handler options for Codex: no token up front, the Keychain read per
 * tool call, Codex's messages.
 * @param {() => Promise<unknown>} [readToken]
 */
export function codexOptions(readToken = () => readKeychainToken()) {
  return {readToken, messages: CODEX_MESSAGES};
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await serve(process.stdin, process.stdout, codexOptions());
}
