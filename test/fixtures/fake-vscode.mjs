// A fake of the parts of the `vscode` module the extension uses, for tests.
// Every interaction is recorded in `log`, so tests can assert what the
// extension asked the editor to do. Tokens are built at runtime and are not
// real tokens.
import { join } from 'node:path';

export const FAKE_TOKENS = Object.freeze({
  full: `wsp_${'3c'.repeat(32)}`,
  connector: `wspc_${'4d'.repeat(32)}`,
  recording: `wspr_${'5e'.repeat(32)}`,
});

export function createEmitter() {
  const listeners = new Set();
  return {
    fired: 0,
    event(listener) {
      listeners.add(listener);
      return { dispose: () => listeners.delete(listener) };
    },
    fire(value) {
      this.fired += 1;
      for (const listener of [...listeners]) listener(value);
    },
    dispose() { listeners.clear(); },
    get size() { return listeners.size; },
  };
}

export class FakeEventEmitter {
  constructor() {
    this.emitter = createEmitter();
    this.event = (listener) => this.emitter.event(listener);
  }

  fire(value) { this.emitter.fire(value); }

  dispose() { this.emitter.dispose(); }
}

export class FakeMcpStdioServerDefinition {
  constructor(label, command, args = [], env = {}, version) {
    this.label = label;
    this.command = command;
    this.args = args;
    this.env = env;
    if (version !== undefined) this.version = version;
  }
}

/** SecretStorage: a Map, with change events like the editor's. */
export function createFakeSecrets(initial = {}) {
  const values = new Map(Object.entries(initial));
  const changes = createEmitter();
  return {
    values,
    async get(key) { return values.get(key); },
    async store(key, value) { values.set(key, value); changes.fire({ key }); },
    async delete(key) { values.delete(key); changes.fire({ key }); },
    onDidChange: (listener) => changes.event(listener),
    fireChange: (key) => changes.fire({ key }),
  };
}

/**
 * The configuration as `inspect` sees it: { key: {globalValue, workspaceValue, workspaceFolderValue, defaultValue} }.
 * @param {Record<string, object>} values
 */
export function createFakeConfiguration(values = {}) {
  return {
    values,
    inspect(key) { return Object.hasOwn(values, key) ? { key: `wisply.${key}`, ...values[key] } : undefined; },
    get() { throw new Error('the extension must not call get(): it would read workspace values'); },
  };
}

/**
 * @param {{mcp?: boolean, cursor?: boolean, config?: Record<string, object>, inputs?: unknown[],
 *   answers?: Record<string, unknown>, appName?: string}} [options]
 *   inputs: values showInputBox resolves, in order (then undefined).
 *   answers: the button each message resolves, keyed by a substring of the message.
 */
export function createFakeVscode({ mcp = true, cursor = false, config = {}, inputs = [], answers = {}, appName = 'Visual Studio Code' } = {}) {
  const log = [];
  const commands = new Map();
  const configuration = createFakeConfiguration(config);
  const configChanges = createEmitter();
  const queue = [...inputs];
  const answer = (message) => {
    for (const [needle, choice] of Object.entries(answers)) if (String(message).includes(needle)) return choice;
    return undefined;
  };
  const message = (kind) => async (text, ...rest) => {
    const options = rest[0] && typeof rest[0] === 'object' ? rest[0] : undefined;
    const buttons = rest.filter((item) => typeof item === 'string');
    log.push({ kind, text, options, buttons });
    return answer(text);
  };
  const vs = {
    log,
    commands: {
      registerCommand(id, run) {
        commands.set(id, run);
        log.push({ kind: 'registerCommand', id });
        return { dispose: () => commands.delete(id) };
      },
      run: (id, ...args) => commands.get(id)(...args),
      registered: () => [...commands.keys()].sort(),
    },
    window: {
      showInputBox: async (options) => {
        const value = queue.shift();
        log.push({ kind: 'inputBox', options, problem: typeof value === 'string' ? options.validateInput?.(value) : undefined });
        return value;
      },
      showInformationMessage: message('info'),
      showWarningMessage: message('warning'),
      showErrorMessage: message('error'),
      withProgress: async (options, task) => {
        log.push({ kind: 'progress', title: options.title });
        return task({ report() {} }, { isCancellationRequested: false });
      },
      createTerminal: (options) => {
        log.push({ kind: 'createTerminal', options });
        return { show: () => log.push({ kind: 'terminalShown', name: options.name }), dispose() {} };
      },
    },
    workspace: {
      getConfiguration(section) {
        log.push({ kind: 'getConfiguration', section });
        return configuration;
      },
      onDidChangeConfiguration: (listener) => configChanges.event(listener),
    },
    env: {
      appName,
      openExternal: async (uri) => { log.push({ kind: 'openExternal', uri: String(uri) }); return true; },
      clipboard: { writeText: async (text) => { log.push({ kind: 'clipboard', text }); } },
    },
    Uri: { parse: (value) => ({ value, toString: () => value }) },
    EventEmitter: FakeEventEmitter,
    ProgressLocation: { SourceControl: 1, Window: 10, Notification: 15 },
    configuration,
    changeConfiguration(updates, affects = (section) => section === 'wisply' || section.startsWith('wisply.')) {
      Object.assign(configuration.values, updates);
      configChanges.fire({ affectsConfiguration: affects });
    },
  };
  if (mcp) {
    vs.McpStdioServerDefinition = FakeMcpStdioServerDefinition;
    vs.lm = {
      providers: new Map(),
      registerMcpServerDefinitionProvider(id, provider) {
        this.providers.set(id, provider);
        log.push({ kind: 'registerMcpServerDefinitionProvider', id });
        return { dispose: () => { this.providers.delete(id); log.push({ kind: 'providerDisposed', id }); } };
      },
    };
  } else {
    // Older VS Code (1.93-1.100): lm exists, the MCP API doesn't.
    vs.lm = { selectChatModels: async () => [] };
  }
  if (cursor) {
    vs.cursor = {
      mcp: {
        registered: [],
        registerServer(serverConfig) {
          this.registered.push(serverConfig);
          log.push({ kind: 'cursorRegister', config: serverConfig });
        },
        unregisterServer(name) {
          log.push({ kind: 'cursorUnregister', name });
        },
      },
    };
  }
  return vs;
}

/** An ExtensionContext for an extension installed at `root`. */
export function createFakeContext({ root = '/ext/wisply', secrets = createFakeSecrets(), version = '0.1.0', state = {} } = {}) {
  const globalState = new Map(Object.entries(state));
  return {
    subscriptions: [],
    secrets,
    asAbsolutePath: (relative) => join(root, relative),
    extension: { packageJSON: { version } },
    globalState: {
      values: globalState,
      get: (key) => globalState.get(key),
      update: async (key, value) => { globalState.set(key, value); },
    },
  };
}
