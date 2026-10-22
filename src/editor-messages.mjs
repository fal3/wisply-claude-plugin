// The connector's texts in this extension: in the bundled connector
// (server/wisply-mcp.mjs) and in the extension's own checks.
//
// The vendored connector tells users, and the AI model that reads a tool
// error, to set WISPLY_MCP_TOKEN in the app's MCP settings or to run the
// connector's setup command. In VS Code, Cursor and the other editors that
// run this bundle, the token comes from the extension instead: Wisply: Set
// Token (the editor's secret storage) or Wisply: Store Token in the Mac
// Keychain. So esbuild.mjs (editorMessagesPlugin) resolves the vendored
// modules' `./messages.mjs` to this file. It re-exports every vendored text
// and replaces the three that say where the token comes from: SETUP,
// MALFORMED and notWisply. They name only the extension's commands, never an
// npm package or npx, so no person or agent is sent to a package name Wisply
// doesn't own yet. ASCII only, like the vendored texts.
//
// Everything else, the lines `setup` prints in the setup terminal included,
// is the vendored file's, unchanged. test/bundle.test.mjs checks that the
// bundle answers with these texts.
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
