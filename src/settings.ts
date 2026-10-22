// The extension's settings, read from the user's own settings only.
//
// Every `wisply.*` setting is declared with `application` scope
// (package.json; test/settings.test.mjs) and listed in
// `capabilities.untrustedWorkspaces.restrictedConfigurations`:
//   - `application`: only the local user settings can set it. `machine` would
//     also accept remote settings, which a repository can write: a dev
//     container's devcontainer.json `customizations.vscode.settings` lands in
//     the container's machine settings, and `inspect().globalValue` is the
//     local and remote user values merged. Application settings are never
//     read from remote settings.
//   - `ignoreSync` on the two settings that decide what the connector may do
//     and where it connects (`wisply.port`, `wisply.mcp.allowClaudeSetup`):
//     Settings Sync doesn't copy them, so turning on setup_claude on one Mac
//     doesn't turn it on everywhere. The three display settings
//     (`wisply.statusBar.enabled`, `wisply.quote.words`,
//     `wisply.quote.format`) may sync.
// On top of that, this file reads only `inspect(key).globalValue`, never
// `.get()`: a repository's .vscode/settings.json (workspace or folder
// values) can't turn on setup_claude, point the extension at another port or
// change what Insert Transcript Quote writes, trusted or not.
import type * as vscode from 'vscode';
import { DEFAULT_PORT, MAX_PORT, MIN_PORT } from '../vendor/wisply-mcp/lib/constants.mjs';
import { DEFAULT_QUOTE_WORDS, MAX_QUOTE_WORDS, MIN_QUOTE_WORDS } from '../vendor/shared.mjs';

export const SECTION = 'wisply';

export type QuoteFormat = 'markdown' | 'plain';
export const QUOTE_FORMATS: readonly QuoteFormat[] = Object.freeze(['markdown', 'plain']);

export interface WisplySettings {
  /** Wisply's MCP port on this Mac. */
  readonly port: number;
  /** Offer setup_claude with a full-access token (spec D4; off by default). */
  readonly allowClaudeSetup: boolean;
  /** Show the status bar item (and poll Wisply for it). */
  readonly statusBarEnabled: boolean;
  /** How many of the live transcript's last words Insert Transcript Quote puts in (10-400). */
  readonly quoteWords: number;
  /** How Insert Transcript Quote formats a quote. */
  readonly quoteFormat: QuoteFormat;
}

export const DEFAULT_SETTINGS: WisplySettings = Object.freeze({
  port: DEFAULT_PORT as number,
  allowClaudeSetup: false,
  statusBarEnabled: true,
  quoteWords: DEFAULT_QUOTE_WORDS as number,
  quoteFormat: 'markdown',
});

/** Keys under `wisply.`. */
export const KEYS = Object.freeze({
  port: 'port',
  allowClaudeSetup: 'mcp.allowClaudeSetup',
  statusBarEnabled: 'statusBar.enabled',
  quoteWords: 'quote.words',
  quoteFormat: 'quote.format',
} as const satisfies Record<keyof WisplySettings, string>);

/** The scope package.json declares for each setting (test/settings.test.mjs compares them). */
export const SCOPES = Object.freeze({
  port: 'application',
  allowClaudeSetup: 'application',
  statusBarEnabled: 'application',
  quoteWords: 'application',
  quoteFormat: 'application',
} as const satisfies Record<keyof WisplySettings, 'application'>);

/** The settings package.json marks `ignoreSync` (the connector's own two). */
export const NOT_SYNCED: readonly (keyof WisplySettings)[] = Object.freeze(['port', 'allowClaudeSetup']);

/** Every setting this extension reads, as `wisply.<key>` (package.json declares exactly these). */
export const SETTING_IDS: readonly string[] = Object.freeze(Object.values(KEYS).map((key) => `${SECTION}.${key}`));

type Inspector = Pick<vscode.WorkspaceConfiguration, 'inspect'>;
export interface ConfigurationHost {
  readonly workspace: { getConfiguration(section: string): Inspector };
}

/** A port is a whole number from 1024 to 65535. */
export function validPort(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value >= MIN_PORT && value <= MAX_PORT ? value : null;
}

/** A word count: a number, rounded and kept within 10-400; anything else is null. */
export function validQuoteWords(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  return Math.min(MAX_QUOTE_WORDS, Math.max(MIN_QUOTE_WORDS, Math.round(value)));
}

export function validQuoteFormat(value: unknown): QuoteFormat | null {
  return typeof value === 'string' && (QUOTE_FORMATS as readonly string[]).includes(value) ? (value as QuoteFormat) : null;
}

function userValue(config: Inspector, key: string): unknown {
  try {
    return config.inspect(key)?.globalValue;
  } catch {
    return undefined;
  }
}

/** The settings from the user's own settings; anything missing or invalid is the default. */
export function readSettings(host: ConfigurationHost): WisplySettings {
  let config: Inspector;
  try {
    config = host.workspace.getConfiguration(SECTION);
  } catch {
    return DEFAULT_SETTINGS;
  }
  return Object.freeze({
    port: validPort(userValue(config, KEYS.port)) ?? DEFAULT_SETTINGS.port,
    allowClaudeSetup: userValue(config, KEYS.allowClaudeSetup) === true,
    statusBarEnabled: userValue(config, KEYS.statusBarEnabled) !== false,
    quoteWords: validQuoteWords(userValue(config, KEYS.quoteWords)) ?? DEFAULT_SETTINGS.quoteWords,
    quoteFormat: validQuoteFormat(userValue(config, KEYS.quoteFormat)) ?? DEFAULT_SETTINGS.quoteFormat,
  });
}

/** Whether a configuration change touches Wisply's settings. */
export function affectsWisply(event: Pick<vscode.ConfigurationChangeEvent, 'affectsConfiguration'>): boolean {
  return event.affectsConfiguration(SECTION);
}

export function sameSettings(a: WisplySettings, b: WisplySettings): boolean {
  return (Object.keys(KEYS) as Array<keyof WisplySettings>).every((key) => a[key] === b[key]);
}

/** Whether two settings start the same connector (the MCP server, Cursor's entry and the sidecar). */
export function sameServerSettings(a: WisplySettings, b: WisplySettings): boolean {
  return a.port === b.port && a.allowClaudeSetup === b.allowClaudeSetup;
}

type Updater = Pick<vscode.WorkspaceConfiguration, 'update'>;
export interface ConfigurationWriter {
  readonly workspace: { getConfiguration(section: string): Updater };
  readonly ConfigurationTarget: { readonly Global: vscode.ConfigurationTarget };
}

/** Writes one display setting to the user's settings (Hide Status Item and its Undo). */
export async function updateUserSetting(host: ConfigurationWriter, key: (typeof KEYS)['statusBarEnabled'],
  value: boolean): Promise<void> {
  await host.workspace.getConfiguration(SECTION).update(key, value, host.ConfigurationTarget.Global);
}
