// The sidecar: the bundled connector as a child process, read-only, for the
// extension's own reads (Check Connection now; the status bar and Insert
// Transcript Quote in DIST-V2). Spec D20.
//
// Why a child process: the extension host patches Node's http module to
// follow the editor's proxy settings (http.proxySupport, default
// "override"), so a request made from extension-host code isn't guaranteed
// to stay on 127.0.0.1. The child is plain Node (`process.execPath` with
// ELECTRON_RUN_AS_NODE=1), outside that patch, and it runs the same bridge
// as every other client: identity check before the token is used, scope
// rules, fixed host. The extension host never sends the token itself.
//
// The child is started lazily, one per window, with `--read-only`, an
// environment of its own (ELECTRON_RUN_AS_NODE, WISPLY_MCP_PORT, HOME, PATH,
// and WISPLY_MCP_TOKEN only when one is stored; nothing else from the
// extension host), stdin and stdout piped and stderr ignored. It gets one
// initialize, then tools/call requests with increasing ids. It is stopped
// after 120 s without calls, on token or port change, after a call times
// out, and on deactivate, and started again by the next call.
import { spawn as nodeSpawn } from 'node:child_process';
import type { ChildProcess, SpawnOptions } from 'node:child_process';
import contract from '../vendor/wisply-mcp/lib/contract.mjs';
import * as messages from '../vendor/wisply-mcp/lib/messages.mjs';
import { toolsFor } from '../vendor/wisply-mcp/lib/scopes.mjs';
import { scopeTitle } from './token';
import type { UsableScope } from './token';

export const READ_ONLY_FLAG = '--read-only';
export const IDLE_MS = 120_000;
export const INITIALIZE_TIMEOUT_MS = 10_000;
/** The bridge caps a tool result at 2 MiB; a longer line isn't the bridge. */
export const MAX_LINE_CHARS = 4 * 1024 * 1024;
export const PROTOCOL_VERSION = '2025-06-18';
export const CLIENT_NAME = 'wisply-vscode';

export type Failure = 'timeout' | 'exited' | 'spawn-failed' | 'disposed' | 'too-large' | 'bad-response';

export interface ToolResult {
  readonly content: ReadonlyArray<{ readonly type: string; readonly text?: string }>;
  readonly structuredContent?: unknown;
  readonly isError?: boolean;
}

export type SidecarAnswer =
  | { readonly kind: 'result'; readonly result: ToolResult }
  | { readonly kind: 'rpc-error'; readonly code: number; readonly message: string }
  | { readonly kind: 'failure'; readonly failure: Failure };

type Spawn = (command: string, args: readonly string[], options: SpawnOptions) => ChildProcess;
type Timers = { setTimeout: typeof setTimeout; clearTimeout: typeof clearTimeout };

export interface SidecarDeps {
  readonly execPath: string;
  readonly serverPath: string;
  /** Read at each start, so a port change takes effect at the next start. */
  getPort(): number;
  /** The stored token, read at each start; null when none is stored. */
  getToken(): Promise<string | null>;
  readonly spawn?: Spawn;
  /** Where HOME and PATH come from (process.env); nothing else is taken. */
  readonly hostEnv?: Readonly<Record<string, string | undefined>>;
  readonly idleMs?: number;
  readonly clientVersion?: string;
  readonly timers?: Timers;
}

export interface Sidecar {
  /** Calls one tool. Never rejects: failures come back as answers. */
  call(tool: string, args: Record<string, unknown>, timeoutMs: number): Promise<SidecarAnswer>;
  /**
   * Stops the child if it was started with another token or port than the
   * ones stored now; the next call starts a new one. Safe to call for every
   * change event: an unchanged token keeps a running child (and its call).
   */
  sync(): Promise<void>;
  /** Stops the child unconditionally; the next call starts a new one. */
  restart(): void;
  dispose(): void;
  /** Whether a child is running now (for tests). */
  readonly running: boolean;
}

/** The child's whole environment. */
export function sidecarEnv({ port, token, hostEnv }: {
  port: number; token: string | null; hostEnv: Readonly<Record<string, string | undefined>>;
}): Record<string, string> {
  const env: Record<string, string> = { ELECTRON_RUN_AS_NODE: '1', WISPLY_MCP_PORT: String(port) };
  for (const name of ['HOME', 'PATH'] as const) {
    const value = hostEnv[name];
    if (typeof value === 'string' && value !== '') env[name] = value;
  }
  if (token) env.WISPLY_MCP_TOKEN = token;
  return env;
}

type Raw = { kind: 'response'; message: Record<string, unknown> } | { kind: 'failure'; failure: Failure };

interface Child {
  readonly process: ChildProcess;
  readonly generation: number;
  readonly token: string | null;
  readonly port: number;
  readonly pending: Map<number, (raw: Raw) => void>;
  nextId: number;
  buffer: string;
  ended: boolean;
  ready: Promise<Raw>;
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

function toAnswer(raw: Raw): SidecarAnswer {
  if (raw.kind === 'failure') return raw;
  const { message } = raw;
  if (isObject(message.error)) {
    const code = Number.isSafeInteger(message.error.code) ? (message.error.code as number) : 0;
    const text = typeof message.error.message === 'string' ? message.error.message : '';
    return { kind: 'rpc-error', code, message: text };
  }
  if (isObject(message.result) && Array.isArray(message.result.content)) {
    return { kind: 'result', result: message.result as unknown as ToolResult };
  }
  return { kind: 'failure', failure: 'bad-response' };
}

export function createSidecar(deps: SidecarDeps): Sidecar {
  const spawn: Spawn = deps.spawn ?? (nodeSpawn as unknown as Spawn);
  const hostEnv = deps.hostEnv ?? process.env;
  const idleMs = deps.idleMs ?? IDLE_MS;
  const timers: Timers = deps.timers ?? { setTimeout, clearTimeout };

  let current: Child | null = null;
  let starting: Promise<Child | null> | null = null;
  let generation = 0;
  let active = 0;
  let disposed = false;
  let idleTimer: ReturnType<typeof setTimeout> | null = null;

  const unref = (timer: ReturnType<typeof setTimeout>) => {
    (timer as { unref?: () => void }).unref?.();
    return timer;
  };

  function end(child: Child, failure: Failure) {
    if (child.ended) return;
    child.ended = true;
    child.buffer = '';
    if (current === child) current = null;
    const waiting = [...child.pending.values()];
    child.pending.clear();
    for (const settle of waiting) settle({ kind: 'failure', failure });
  }

  function stop(child: Child, failure: Failure) {
    end(child, failure);
    try { child.process.stdin?.end(); } catch { /* already closed */ }
    try { child.process.kill(); } catch { /* already gone */ }
  }

  function write(child: Child, message: object) {
    try {
      child.process.stdin?.write(`${JSON.stringify(message)}\n`);
    } catch {
      stop(child, 'exited');
    }
  }

  function request(child: Child, method: string, params: object, timeoutMs: number): Promise<Raw> {
    if (child.ended) return Promise.resolve({ kind: 'failure', failure: 'exited' });
    const id = child.nextId;
    child.nextId += 1;
    return new Promise((resolve) => {
      const timer = unref(timers.setTimeout(() => {
        child.pending.delete(id);
        resolve({ kind: 'failure', failure: 'timeout' });
        // The bridge answers in order, so a stuck request blocks the rest:
        // start over with a fresh child.
        stop(child, 'timeout');
      }, timeoutMs));
      child.pending.set(id, (raw) => {
        timers.clearTimeout(timer);
        resolve(raw);
      });
      write(child, { jsonrpc: '2.0', id, method, params });
    });
  }

  function onLine(child: Child, line: string) {
    if (!line.trim()) return;
    let message: unknown;
    try { message = JSON.parse(line); } catch { return; }
    if (!isObject(message) || typeof message.id !== 'number') return;
    const settle = child.pending.get(message.id);
    if (!settle) return;
    child.pending.delete(message.id);
    settle({ kind: 'response', message });
  }

  function onData(child: Child, chunk: string) {
    if (child.ended) return;
    child.buffer += chunk;
    let newline = child.buffer.indexOf('\n');
    while (newline >= 0) {
      const line = child.buffer.slice(0, newline);
      child.buffer = child.buffer.slice(newline + 1);
      onLine(child, line);
      newline = child.buffer.indexOf('\n');
    }
    if (child.buffer.length > MAX_LINE_CHARS) stop(child, 'too-large');
  }

  async function start(): Promise<Child | null> {
    const startedFor = generation;
    let token: string | null = null;
    try { token = await deps.getToken(); } catch { token = null; }
    if (disposed) return null;
    const port = deps.getPort();
    const env = sidecarEnv({ port, token, hostEnv });
    let proc: ChildProcess;
    try {
      proc = spawn(deps.execPath, [deps.serverPath, READ_ONLY_FLAG], {
        env, stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true,
      });
    } catch {
      return null;
    }
    const child: Child = {
      process: proc, generation: startedFor, token, port, pending: new Map(), nextId: 1, buffer: '', ended: false,
      ready: Promise.resolve({ kind: 'failure', failure: 'exited' }),
    };
    proc.on('error', () => end(child, 'spawn-failed'));
    proc.on('exit', () => end(child, 'exited'));
    proc.stdin?.on('error', () => { /* the child went away; 'exit' follows */ });
    proc.stdout?.setEncoding('utf8');
    proc.stdout?.on('data', (chunk: string) => onData(child, chunk));
    // One child per window: a previous one that is still running goes.
    if (current && current !== child && !current.ended) stop(current, 'exited');
    current = child;
    child.ready = request(child, 'initialize', {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: CLIENT_NAME, version: deps.clientVersion ?? '0.0.0' },
    }, INITIALIZE_TIMEOUT_MS).then((raw) => {
      if (raw.kind === 'response' && !child.ended) write(child, { jsonrpc: '2.0', method: 'notifications/initialized' });
      return raw;
    });
    return child;
  }

  async function ensure(): Promise<Child | null> {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      if (current && !current.ended && current.generation === generation) return current;
      if (!starting) starting = start().finally(() => { starting = null; });
      const child = await starting;
      if (!child || disposed) return null;
      if (child.generation === generation) return child;
      // restart() ran while this child was starting: it may hold the old token.
      stop(child, 'exited');
    }
    return null;
  }

  function clearIdle() {
    if (idleTimer !== null) timers.clearTimeout(idleTimer);
    idleTimer = null;
  }

  function armIdle() {
    clearIdle();
    if (active > 0 || !current || disposed) return;
    const child = current;
    idleTimer = unref(timers.setTimeout(() => {
      idleTimer = null;
      if (active === 0 && current === child) stop(child, 'exited');
    }, idleMs));
  }

  return {
    async call(tool, args, timeoutMs) {
      if (disposed) return { kind: 'failure', failure: 'disposed' };
      clearIdle();
      active += 1;
      try {
        const child = await ensure();
        if (!child) return { kind: 'failure', failure: disposed ? 'disposed' : 'spawn-failed' };
        const ready = await child.ready;
        if (ready.kind === 'failure') return ready;
        if (isObject(ready.message.error)) return { kind: 'failure', failure: 'bad-response' };
        return toAnswer(await request(child, 'tools/call', { name: tool, arguments: args }, timeoutMs));
      } finally {
        active -= 1;
        armIdle();
      }
    },
    async sync() {
      let token: string | null = null;
      try { token = await deps.getToken(); } catch { token = null; }
      if (disposed) return;
      // A child still starting may have read the old token: make the next
      // call start again (ensure() compares generations).
      if (starting) generation += 1;
      const child = current;
      if (child && !child.ended && (child.token !== token || child.port !== deps.getPort())) {
        generation += 1;
        clearIdle();
        stop(child, 'exited');
      }
    },
    restart() {
      generation += 1;
      clearIdle();
      if (current) stop(current, 'exited');
    },
    dispose() {
      disposed = true;
      generation += 1;
      clearIdle();
      if (current) stop(current, 'disposed');
    },
    get running() {
      return current !== null && !current.ended;
    },
  };
}

// --- Check Connection -------------------------------------------------------

/** The tool Check Connection calls: small on every Wisply build, read-only. */
export const CHECK_TOOL = 'list_memos';
export const CHECK_ARGUMENTS = Object.freeze({ limit: 1 });
export const CHECK_TIMEOUT_MS = 15_000;

export const CONNECTION_TEXT = Object.freeze({
  ok: (port: number) => `Wisply answered on 127.0.0.1:${port} and proved its identity.`,
  tools: (scope: UsableScope, count: number) => `${scopeTitle(scope)} token: ${count} tools.`,
  keychain: 'It used the token saved in the Mac Keychain.',
  setup: 'Wisply token is not set. In Wisply on this Mac, open Settings > Integrations > MCP Server and copy the ' +
    'read-only connector token. Then run Wisply: Set Token… (or Wisply: Store Token in the Mac Keychain… for ' +
    'other apps on this Mac).',
  failed: "Wisply's connector didn't answer in this editor, so the connection wasn't checked. Reload the window " +
    'and try again.',
});

export type ConnectionReport =
  | { readonly kind: 'ok'; readonly text: string }
  | { readonly kind: 'setup'; readonly text: string }
  | { readonly kind: 'problem'; readonly text: string };

const toolText = (result: ToolResult) =>
  result.content.filter((block) => block?.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text).join(' ').trim();

/**
 * What Check Connection tells the user. `stored` is the token in
 * SecretStorage (null: the connector used the Keychain item, if any). The
 * tool count is what the editor's MCP server offers with that token.
 */
export function describeConnection(answer: SidecarAnswer, { port, stored, allowClaudeSetup }: {
  port: number; stored: UsableScope | null; allowClaudeSetup: boolean;
}): ConnectionReport {
  if (answer.kind === 'failure') return { kind: 'problem', text: CONNECTION_TEXT.failed };
  if (answer.kind === 'rpc-error') {
    return { kind: 'problem', text: answer.message || CONNECTION_TEXT.failed };
  }
  if (answer.result.isError === true) {
    const text = toolText(answer.result);
    if (text === messages.SETUP) return { kind: 'setup', text: CONNECTION_TEXT.setup };
    return { kind: 'problem', text: text || CONNECTION_TEXT.failed };
  }
  const detail = stored
    ? CONNECTION_TEXT.tools(stored, toolsFor(contract, stored, { allowClaudeSetup }).length)
    : CONNECTION_TEXT.keychain;
  return { kind: 'ok', text: `${CONNECTION_TEXT.ok(port)} ${detail}` };
}
