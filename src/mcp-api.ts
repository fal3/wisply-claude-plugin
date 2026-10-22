/// <reference path="./mcp-api.d.ts" />
// Runtime detection of the editor's MCP server API.
//
// VS Code has `vscode.lm.registerMcpServerDefinitionProvider` and
// `vscode.McpStdioServerDefinition` from 1.101. The extension installs from
// 1.93 (D19), so in an older VS Code, or in a fork on an older base (Cursor,
// Windsurf, Kiro), the API may be missing; the extension then tries Cursor's
// own API (src/cursor.ts) or shows the manual setup notice.

export type McpApi = WisplyVscodeMcp.Api;
export type McpStdioServerDefinition = WisplyVscodeMcp.McpStdioServerDefinition;
export type McpServerDefinitionProvider = WisplyVscodeMcp.McpServerDefinitionProvider<McpStdioServerDefinition>;

const isObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && (typeof value === 'object' || typeof value === 'function');

/**
 * The MCP server API of the running editor, or null when it lacks either
 * piece. Takes the `vscode` module (injected, so tests pass a fake).
 */
export function getMcpApi(vscodeModule: unknown): McpApi | null {
  if (!isObject(vscodeModule)) return null;
  const lm = vscodeModule.lm;
  const Definition = vscodeModule.McpStdioServerDefinition;
  if (!isObject(lm) || typeof lm.registerMcpServerDefinitionProvider !== 'function') return null;
  if (typeof Definition !== 'function') return null;
  const register = lm.registerMcpServerDefinitionProvider as McpApi['registerMcpServerDefinitionProvider'];
  return {
    McpStdioServerDefinition: Definition as WisplyVscodeMcp.McpStdioServerDefinitionConstructor,
    registerMcpServerDefinitionProvider: (id, provider) => register.call(lm, id, provider),
  };
}
