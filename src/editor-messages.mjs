// The connector's texts in this extension: in the bundled connector
// (server/wisply-mcp.mjs) and in the extension's own checks.
//
// The vendored connector tells users, and the AI model that reads a tool
// error, to set WISPLY_MCP_TOKEN in the app's MCP settings or to run the
// connector's commands (`wisply-mcp setup`, `setup --full-access`,
// `forget`). In VS Code, Cursor and the other editors that run this bundle,
// none of those commands exists on the PATH: the token comes from the
// extension instead, through Wisply: Set Token (the editor's secret storage)
// or Wisply: Store Token in the Mac Keychain (a terminal that runs this
// bundle's `setup` itself and then closes). So esbuild.mjs
// (editorMessagesPlugin) resolves the vendored modules' `./messages.mjs` to
// this file. It re-exports every vendored text and replaces
//   - the three that tell chat where the token comes from: SETUP, MALFORMED
//     and notWisply;
//   - keychainUnavailable, which chat and Check Connection show for a 503
//     that any program on the port could send: it must not tell the user to
//     approve a Keychain dialog that program may have opened;
//   - every text `setup` prints in the setup terminal that names a command
//     (FULL_ACCESS_REFUSED, SETUP_MALFORMED, READ_BACK_FAILED,
//     RECORDING_SHARED, ...), and
//     identityProblem, so the vendored texts' own references to the vendored
//     notWisply and keychainUnavailable resolve here too.
// The replacements name only the extension's commands and Keychain Access,
// never an npm package, npx or a connector command, so no person or agent is
// sent to a command that isn't there or a package name Wisply doesn't own
// yet. ASCII only, like the vendored texts.
//
// The texts left as vendored either name no command, or come only from
// arguments the extension never passes (--help, a bad --port, status,
// forget). test/bundle.test.mjs runs `setup` through every path with these
// texts and checks that the bundle answers with them.
import { KEYCHAIN_LABEL } from '../vendor/wisply-mcp/lib/constants.mjs';
import { UPDATE_WISPLY, UPDATE_WISPLY_SCOPE, unavailable } from '../vendor/wisply-mcp/lib/messages.mjs';

export * from '../vendor/wisply-mcp/lib/messages.mjs';

/** The extension's commands as the Command Palette finds them (ASCII, so without the ellipsis). */
export const EDITOR_COMMANDS = Object.freeze({
  setToken: 'Wisply: Set Token',
  storeInKeychain: 'Wisply: Store Token in the Mac Keychain',
});

/** Where the token comes from in an editor, as the end of a sentence. */
const TOKEN_STEP =
  `run ${EDITOR_COMMANDS.setToken} from the Command Palette and restart the Wisply MCP server. In Cursor and ` +
  `other editors without VS Code's MCP API, run ${EDITOR_COMMANDS.storeInKeychain} instead`;

export const SETUP =
  'Wisply MCP token is not set. In Wisply on this Mac, open Settings > Integrations > MCP Server and copy the ' +
  `read-only connector token. Then ${TOKEN_STEP}.`;

export const MALFORMED =
  "WISPLY_MCP_TOKEN is set but isn't a Wisply token (it should start with wspc_, wspr_ or wsp_ and have 64 hex " +
  `characters). Copy the read-only connector token from Wisply > Settings > Integrations > MCP Server, then ${TOKEN_STEP}.`;

/** @param {number} port */
export const notWisply = (port) =>
  `Wisply identity check failed: the program on 127.0.0.1:${port} couldn't prove it is the Wisply that issued ` +
  `this token, so the token wasn't sent. If you regenerated the token in Wisply, ${TOKEN_STEP}. Otherwise quit ` +
  'whatever is using that port.';

/**
 * Wisply's 503 for the identity check (it couldn't read its tokens from the
 * Keychain). Any program on the port can send the same answer, so the advice
 * never asks the user to approve a Keychain dialog unless it names Wisply.
 * @param {number} port
 */
export const keychainUnavailable = (port) =>
  `Wisply on 127.0.0.1:${port} couldn't read its MCP tokens from the Keychain, so the token wasn't sent. ` +
  'Quit and reopen Wisply. If macOS asks for Keychain access, allow it only when the dialog names Wisply.';

// --- The setup terminal (Wisply: Store Token in the Mac Keychain) ---------
//
// The terminal runs this bundle's `setup` and closes when it ends, so "again"
// means the extension's command, and full access means Set Token: the
// extension never runs `setup --full-access`.

/** Running the Keychain command again, as the end of a sentence. */
const SETUP_AGAIN = `run ${EDITOR_COMMANDS.storeInKeychain} again from the Command Palette`;

/** How to delete the item by hand, as a sentence. */
const DELETE_BY_HAND =
  `Open Keychain Access, search for "${KEYCHAIN_LABEL}" and delete every item it finds.`;

export const SETUP_NEEDS_TERMINAL =
  "setup needs a terminal: macOS asks for the token there, so it never passes through this program or its output. " +
  `Run ${EDITOR_COMMANDS.storeInKeychain} from the Command Palette.`;

export const REPLACE_FAILED =
  `Couldn't remove the "${KEYCHAIN_LABEL}" saved before, so setup stopped before asking for the new token. ` +
  `${DELETE_BY_HAND} Then ${SETUP_AGAIN}.`;

export const PREVIOUS_REMOVED =
  `The token saved before had already been removed, so AI apps that use "${KEYCHAIN_LABEL}" have no token ` +
  `until you ${SETUP_AGAIN} and it succeeds.`;

export const KEYCHAIN_NOT_STORED =
  `macOS didn't store the token (the two entries may not have matched). To try again, ${SETUP_AGAIN}.`;

export const SETUP_MALFORMED =
  "That isn't a Wisply token (it should start with wspc_, wspr_ or wsp_ and have 64 hex characters), so it " +
  "wasn't saved. Copy the read-only connector token from Wisply > Settings > Integrations > MCP Server, then " +
  `${SETUP_AGAIN}.`;

export const READ_BACK_FAILED =
  "macOS stored the token, but it couldn't be read back to check it, so it was removed again. " +
  `To try again, ${SETUP_AGAIN}.`;

export const FULL_ACCESS_REFUSED =
  "That is Wisply's full-access token, so it wasn't saved. To store the read-only connector token instead, " +
  `${SETUP_AGAIN}. If VS Code's AI chat needs recording control and follow-ups, use ${EDITOR_COMMANDS.setToken} ` +
  'instead: it asks you to confirm a full-access token. A token in the Mac Keychain only ever gets the read-only ' +
  'memo tools in this extension.';

/** @param {'full-access'|'malformed'|'unreadable'} reason */
export const removeFailed = (reason) =>
  (reason === 'full-access'
    ? "That is Wisply's full-access token. It was stored, and removing it again failed. "
    : "The value macOS stored couldn't be kept, and removing it again failed. ") +
  `${DELETE_BY_HAND} Then ${SETUP_AGAIN} with the read-only connector token.`;

/** Unreachable from the extension (it never passes --full-access); replaced so no text names the command. */
export const FULL_ACCESS_SHARED =
  'Every AI app on this Mac that starts the connector without its own WISPLY_MCP_TOKEN now gets full access, ' +
  `including recording control and follow-ups. To undo this, ${SETUP_AGAIN} with the read-only connector token.`;

/**
 * After the terminal stored a recording-control token (setup keeps a wspr_
 * token): every other AI app that reads the Keychain item without a token of
 * its own can now start and stop recordings. This editor's own connectors
 * read the item with --read-only, so they don't.
 */
export const RECORDING_SHARED =
  'Every AI app on this Mac that starts the Wisply connector without its own WISPLY_MCP_TOKEN can now start and ' +
  'stop recordings while Wisply allows agents to ("Allow agents to start and stop recordings"), and propose ' +
  "follow-ups for you to confirm in Wisply. This editor's chat still gets only the read-only memo tools from the " +
  `Keychain. To undo this, ${SETUP_AGAIN} with the read-only connector token.`;

/**
 * The full text for an identity check that didn't pass, as tools/call shows
 * it or as setup prints it. The vendored function refers to the vendored
 * texts, so it is replaced as well; the terminal and chat get the same
 * texts here, since both point to the extension's commands.
 * @param {'unavailable'|'not-wisply'|'old-wisply'|'missing-scope'|'keychain'|string} outcome
 * @param {number} port
 * @param {{terminal?: boolean}} [_options]
 */
export const identityProblem = (outcome, port, _options = {}) => {
  if (outcome === 'unavailable') return unavailable(port);
  if (outcome === 'old-wisply') return UPDATE_WISPLY;
  if (outcome === 'missing-scope') return UPDATE_WISPLY_SCOPE;
  if (outcome === 'keychain') return keychainUnavailable(port);
  return notWisply(port);
};
