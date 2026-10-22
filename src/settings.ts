// The extension's settings, read from the user's own settings only.
//
// Every `wisply.*` setting is declared with `application` or `machine` scope
// and listed in `capabilities.untrustedWorkspaces.restrictedConfigurations`
// (package.json; test/settings.test.mjs). On top of that, this file reads
// only `inspect(key).globalValue`, never `.get()`: a repository's
// .vscode/settings.json (workspace or folder values) can't turn on
// setup_claude or point the extension at another port, trusted or not.
import type * as vscode from 'vscode';
import { DEFAULT_PORT, MAX_PORT, MIN_PORT } from '../vendor/wisply-mcp/lib/constants.mjs';

export const SECTION = 'wisply';

export interface WisplySettings {
  /** Wisply's MCP port on this Mac. */
  readonly port: number;
  /** Offer setup_claude with a full-access token (spec D4; off by default). */
  readonly allowClaudeSetup: boolean;
}

export const DEFAULT_SETTINGS: WisplySettings = Object.freeze({
  port: DEFAULT_PORT as number,
  allowClaudeSetup: false,
});

/** Keys under `wisply.`, and how a user value becomes a setting. */
const KEYS = Object.freeze({
  port: 'port',
  allowClaudeSetup: 'mcp.allowClaudeSetup',
} as const satisfies Record<keyof WisplySettings, string>);

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
  });
}

/** Whether a configuration change touches Wisply's settings. */
export function affectsWisply(event: Pick<vscode.ConfigurationChangeEvent, 'affectsConfiguration'>): boolean {
  return event.affectsConfiguration(SECTION);
}

export function sameSettings(a: WisplySettings, b: WisplySettings): boolean {
  return a.port === b.port && a.allowClaudeSetup === b.allowClaudeSetup;
}
