// The Wisply token in the editor's SecretStorage, and the Set Token prompt.
//
// The token lives only in SecretStorage (key "wisply.mcpToken"). It leaves
// the extension host in exactly two ways, both as WISPLY_MCP_TOKEN in a
// child process's environment: the MCP server the editor starts
// (src/provider.ts, added when the server starts, never in a provided
// definition) and the read-only sidecar (src/sidecar.ts). The extension host
// itself never sends it anywhere.
import type * as vscode from 'vscode';
import { SCOPE_LABELS, scopeOfToken } from '../vendor/wisply-mcp/lib/scopes.mjs';

export const SECRET_KEY = 'wisply.mcpToken';

export type Scope = 'full' | 'connector' | 'recording';
/** Scopes the extension accepts: a recording-control token can't read memos. */
export type UsableScope = 'full' | 'connector';
export interface StoredToken {
  readonly token: string;
  readonly scope: UsableScope;
}
export type TokenCheck =
  | { readonly ok: true; readonly token: string; readonly scope: UsableScope }
  | { readonly ok: false; readonly scope: Scope | null; readonly problem: 'empty' | 'malformed' | 'recording' };

export const TOKEN_TEXT = Object.freeze({
  title: 'Wisply: Set Token',
  prompt: 'Paste the read-only connector token from Wisply > Settings > Integrations > MCP Server',
  placeholder: 'wspc_...',
  malformed: "That isn't a Wisply token. It starts with wspc_ (or wsp_) and has 64 hex characters.",
  recording: "This token can only start and stop recordings, so it can't read memos. Paste the connector token.",
  fullAccessWarning: "This is Wisply's full-access token. AI chat will be able to start and stop recordings " +
    '(if you allow it in Wisply) and propose follow-ups. Use the read-only connector token unless you need that.',
  useFullAccess: 'Use Full Access',
});

/** "read-only connector" -> "Read-only connector". */
export function scopeTitle(scope: Scope): string {
  const label: string = SCOPE_LABELS[scope];
  return label.charAt(0).toUpperCase() + label.slice(1);
}

/** Checks a pasted or stored value (surrounding whitespace ignored). */
export function validateToken(raw: unknown): TokenCheck {
  const value = typeof raw === 'string' ? raw.trim() : '';
  if (value === '') return { ok: false, scope: null, problem: 'empty' };
  const scope = scopeOfToken(value) as Scope | null;
  if (scope === null) return { ok: false, scope: null, problem: 'malformed' };
  if (scope === 'recording') return { ok: false, scope, problem: 'recording' };
  return { ok: true, token: value, scope };
}

/** The input box's validation text: nothing while empty or valid. */
export function inputProblem(value: string): string | undefined {
  const check = validateToken(value);
  if (check.ok || check.problem === 'empty') return undefined;
  return check.problem === 'recording' ? TOKEN_TEXT.recording : TOKEN_TEXT.malformed;
}

type PromptWindow = Pick<typeof vscode.window, 'showInputBox' | 'showWarningMessage'>;

/**
 * Asks for a token in a password box. A full-access token needs a second,
 * modal confirmation. Resolves the token, or undefined when the user cancels.
 */
export async function promptForToken(window: PromptWindow): Promise<StoredToken | undefined> {
  const value = await window.showInputBox({
    title: TOKEN_TEXT.title,
    prompt: TOKEN_TEXT.prompt,
    placeHolder: TOKEN_TEXT.placeholder,
    password: true,
    ignoreFocusOut: true,
    validateInput: inputProblem,
  });
  const check = validateToken(value);
  if (!check.ok) return undefined;
  if (check.scope === 'full') {
    const choice = await window.showWarningMessage(TOKEN_TEXT.fullAccessWarning, { modal: true }, TOKEN_TEXT.useFullAccess);
    if (choice !== TOKEN_TEXT.useFullAccess) return undefined;
  }
  return { token: check.token, scope: check.scope };
}

export interface SecretStore {
  get(key: string): Thenable<string | undefined>;
  store(key: string, value: string): Thenable<void>;
  delete(key: string): Thenable<void>;
  readonly onDidChange: vscode.Event<{ readonly key: string }>;
}

export interface TokenStore {
  /** The stored token if it is usable; null when none (or a corrupt value) is stored. */
  get(): Promise<StoredToken | null>;
  set(token: StoredToken): Promise<void>;
  forget(): Promise<void>;
  /** Fires when the stored token changes, in this window or another one. */
  onDidChange(listener: () => void): vscode.Disposable;
}

export function createTokenStore(secrets: SecretStore): TokenStore {
  return {
    async get() {
      let raw: string | undefined;
      try {
        raw = await secrets.get(SECRET_KEY);
      } catch {
        return null;
      }
      const check = validateToken(raw);
      return check.ok ? { token: check.token, scope: check.scope } : null;
    },
    async set(stored) {
      const check = validateToken(stored.token);
      if (!check.ok) throw new TypeError('Not a usable Wisply token');
      await secrets.store(SECRET_KEY, check.token);
    },
    async forget() {
      await secrets.delete(SECRET_KEY);
    },
    onDidChange(listener) {
      return secrets.onDidChange((event) => {
        if (event.key === SECRET_KEY) listener();
      });
    },
  };
}
