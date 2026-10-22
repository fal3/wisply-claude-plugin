// The status bar item: Wisply's recording state, read through the sidecar.
//
//   $(record) Wisply 12:04       recording (warning background)
//   $(debug-pause) Wisply 12:04  paused
//   $(mic) Wisply                not recording
//   $(key) Wisply                no token (Set Token… or the Keychain item)
//   $(debug-disconnect) Wisply   Wisply isn't answering
//   $(warning) Wisply            any other problem (identity check, an old Wisply, …)
//
// The tooltip is "Wisply: recording · 1,204 words · 3 speakers" or the
// problem text. It never holds transcript text. Clicking opens the Wisply
// menu (pickMenuAction).
//
// Each poll is one `get_live_transcript {"tail_words": 1}` through the
// read-only sidecar (src/sidecar.ts, D20), so the extension host never sends
// the token. Polling runs only while the window is focused and
// `wisply.statusBar.enabled` is on, on macOS: every 10 s while a recording is
// in progress, 30 s when idle, 60 s when Wisply isn't answering or something
// else is wrong. Wisply builds older than the recording-control token (no
// `agent_recording_control` in the payload) ignore `tail_words` and send the
// whole transcript, so they are polled every 60 s. The item stays hidden
// until the first answer, and while the setting is off.
import type * as vscode from 'vscode';
import { formatDuration, parseLiveTranscript } from '../vendor/shared.mjs';
import * as messages from './editor-messages.mjs';
import { payloadOf, toolText } from './results';
import { CONNECTION_TEXT } from './sidecar';
import type { SidecarAnswer } from './sidecar';

export const STATUS_ITEM_ID = 'wisply.status';
export const STATUS_ITEM_NAME = 'Wisply';
export const STATUS_PRIORITY = 100;
export const LIVE_TOOL = 'get_live_transcript';
export const STATUS_ARGUMENTS = Object.freeze({ tail_words: 1 });
/** The connector gives the call 5 s and the identity check 3 s; the rest is the child's start. */
export const STATUS_TIMEOUT_MS = 15_000;
export const WARNING_BACKGROUND = 'statusBarItem.warningBackground';

export const POLL_MS = Object.freeze({
  live: 10_000,
  idle: 30_000,
  /** Not answering, a problem, no token, or a Wisply build that ignores tail_words. */
  slow: 60_000,
});

export type StatusPhase = 'recording' | 'paused' | 'idle' | 'unknown' | 'setup' | 'unavailable' | 'problem';

export interface StatusSnapshot {
  readonly phase: StatusPhase;
  readonly durationSeconds: number;
  readonly wordCount: number;
  readonly speakerCount: number;
  /** Whether Wisply honors tail_words (its payload has agent_recording_control). */
  readonly current: boolean;
  /** What's wrong, for the problem phases; '' otherwise. */
  readonly problem: string;
}

export const STATUS_TEXT = Object.freeze({
  idle: 'Wisply: not recording',
  unknown: 'Wisply: recording state not known',
  unreadable: "Wisply answered, but not with a recording state this extension can read. Update Wisply and the " +
    'Wisply extension.',
});

const SNAPSHOT_DEFAULTS = Object.freeze({ durationSeconds: 0, wordCount: 0, speakerCount: 0, current: false, problem: '' });

const problemSnapshot = (phase: 'setup' | 'unavailable' | 'problem', problem: string): StatusSnapshot =>
  Object.freeze({ ...SNAPSHOT_DEFAULTS, phase, problem });

/**
 * What a get_live_transcript answer says about Wisply. null for an answer
 * that says nothing (the sidecar was disposed).
 */
export function snapshotFromAnswer(answer: SidecarAnswer, port: number): StatusSnapshot | null {
  if (answer.kind === 'failure') {
    return answer.failure === 'disposed' ? null : problemSnapshot('problem', CONNECTION_TEXT.failed);
  }
  if (answer.kind === 'rpc-error') return problemSnapshot('problem', answer.message || CONNECTION_TEXT.failed);
  if (answer.result.isError === true) {
    const text = toolText(answer.result);
    if (text === messages.SETUP) return problemSnapshot('setup', CONNECTION_TEXT.setup);
    if (text === messages.MALFORMED) return problemSnapshot('setup', text);
    if (text === messages.unavailable(port)) return problemSnapshot('unavailable', text);
    return problemSnapshot('problem', text || CONNECTION_TEXT.failed);
  }
  const live = parseLiveTranscript(answer.result);
  if (!live) return problemSnapshot('problem', STATUS_TEXT.unreadable);
  const payload = payloadOf(answer.result);
  return Object.freeze({
    phase: live.state,
    durationSeconds: live.durationSeconds,
    wordCount: live.wordCount,
    speakerCount: live.speakerCount,
    current: payload !== null && Object.hasOwn(payload, 'agent_recording_control'),
    problem: '',
  });
}

/** How long to wait before the next poll after this snapshot. */
export function pollDelayMs(snapshot: StatusSnapshot): number {
  switch (snapshot.phase) {
    case 'recording':
    case 'paused':
      return snapshot.current ? POLL_MS.live : POLL_MS.slow;
    case 'idle':
    case 'unknown':
      return snapshot.current ? POLL_MS.idle : POLL_MS.slow;
    default:
      return POLL_MS.slow;
  }
}

const COUNT = new Intl.NumberFormat('en-US');
const counted = (count: number, word: string) => `${COUNT.format(count)} ${word}${count === 1 ? '' : 's'}`;

export interface StatusView {
  readonly text: string;
  readonly tooltip: string;
  /** Whether the item gets the warning background (a recording is running). */
  readonly warning: boolean;
}

/** The item's text and tooltip for a snapshot (pure). */
export function statusText(snapshot: StatusSnapshot): StatusView {
  switch (snapshot.phase) {
    case 'recording':
    case 'paused': {
      const parts = [`Wisply: ${snapshot.phase}`, counted(snapshot.wordCount, 'word')];
      if (snapshot.speakerCount > 0) parts.push(counted(snapshot.speakerCount, 'speaker'));
      const icon = snapshot.phase === 'recording' ? '$(record)' : '$(debug-pause)';
      return {
        text: `${icon} Wisply ${formatDuration(snapshot.durationSeconds)}`,
        tooltip: parts.join(' · '),
        warning: snapshot.phase === 'recording',
      };
    }
    case 'idle':
      return { text: '$(mic) Wisply', tooltip: STATUS_TEXT.idle, warning: false };
    case 'unknown':
      return { text: '$(mic) Wisply', tooltip: STATUS_TEXT.unknown, warning: false };
    case 'setup':
      return { text: '$(key) Wisply', tooltip: snapshot.problem, warning: false };
    case 'unavailable':
      return { text: '$(debug-disconnect) Wisply', tooltip: snapshot.problem, warning: false };
    default:
      return { text: '$(warning) Wisply', tooltip: snapshot.problem, warning: false };
  }
}

// --- The controller -------------------------------------------------------

type Timers = { setTimeout: typeof setTimeout; clearTimeout: typeof clearTimeout };

export interface StatusWindow {
  createStatusBarItem(id: string, alignment?: vscode.StatusBarAlignment, priority?: number): vscode.StatusBarItem;
  readonly state: { readonly focused: boolean };
  readonly onDidChangeWindowState: vscode.Event<{ readonly focused: boolean }>;
}

export interface StatusDeps {
  readonly window: StatusWindow;
  readonly ThemeColor: new (id: string) => vscode.ThemeColor;
  readonly alignment: vscode.StatusBarAlignment;
  /** The command the item runs when clicked (the Wisply menu). */
  readonly command: string;
  /** The sidecar's call. */
  call(tool: string, args: Record<string, unknown>, timeoutMs: number): Promise<SidecarAnswer>;
  getPort(): number;
  /** The setting is on and this is a Mac. */
  isEnabled(): boolean;
  readonly timers?: Timers;
  readonly now?: () => number;
}

export interface StatusController extends vscode.Disposable {
  /** Polls now when the window is focused; otherwise as soon as it is. Settles when that poll is done. */
  refresh(): Promise<void>;
  /** The port or wisply.statusBar.enabled may have changed: show, hide or refresh. */
  settingsChanged(): Promise<void>;
  /** A get_live_transcript answer from elsewhere (Insert Transcript Quote): shown at once, and the next poll waits. */
  report(answer: SidecarAnswer): void;
  /** The last snapshot shown; null while the item is hidden. */
  readonly snapshot: StatusSnapshot | null;
  /** Whether a poll is scheduled (for tests). */
  readonly scheduled: boolean;
}

export function createStatusController(deps: StatusDeps): StatusController {
  const timers: Timers = deps.timers ?? { setTimeout, clearTimeout };
  const now = deps.now ?? Date.now;
  let item: vscode.StatusBarItem | null = null;
  let snapshot: StatusSnapshot | null = null;
  let lastAt = Number.NEGATIVE_INFINITY;
  let stale = true;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let inFlight: Promise<void> | null = null;
  let queued: Promise<void> | null = null;
  let disposed = false;
  let enabled = deps.isEnabled();
  let port = deps.getPort();
  /** Bumped when the port or the setting changes: answers to polls started before are dropped. */
  let generation = 0;

  const active = () => !disposed && enabled;
  const focused = () => deps.window.state?.focused === true;

  function clear() {
    if (timer !== null) timers.clearTimeout(timer);
    timer = null;
  }

  function render() {
    if (!active() || !snapshot) {
      item?.hide();
      return;
    }
    if (!item) {
      item = deps.window.createStatusBarItem(STATUS_ITEM_ID, deps.alignment, STATUS_PRIORITY);
      item.name = STATUS_ITEM_NAME;
      item.command = deps.command;
    }
    const view = statusText(snapshot);
    item.text = view.text;
    item.tooltip = view.tooltip;
    item.accessibilityInformation = { label: view.tooltip };
    item.backgroundColor = view.warning ? new deps.ThemeColor(WARNING_BACKGROUND) : undefined;
    item.show();
  }

  function schedule() {
    clear();
    if (!active() || !focused() || inFlight) return;
    const due = stale || !snapshot ? 0 : Math.max(0, lastAt + pollDelayMs(snapshot) - now());
    const handle = timers.setTimeout(() => {
      timer = null;
      void poll();
    }, due);
    (handle as { unref?: () => void }).unref?.();
    timer = handle;
  }

  function accept(answer: SidecarAnswer, askedIn = generation) {
    if (!active() || askedIn !== generation) return;
    const next = snapshotFromAnswer(answer, deps.getPort());
    if (!next) return;
    snapshot = next;
    lastAt = now();
    stale = false;
    try {
      render();
    } catch {
      // The status bar item is a convenience: it never breaks a command or the polling.
    }
  }

  function poll(): Promise<void> {
    if (!active()) return Promise.resolve();
    if (inFlight) {
      // One request at a time: ask again once the current one is done.
      if (!queued) queued = inFlight.then(() => { queued = null; return poll(); });
      return queued;
    }
    clear();
    const askedIn = generation;
    const started = deps.call(LIVE_TOOL, { ...STATUS_ARGUMENTS }, STATUS_TIMEOUT_MS)
      .then((answer) => accept(answer, askedIn))
      .catch(() => { /* the sidecar never rejects; keep polling regardless */ })
      .finally(() => {
        inFlight = null;
        if (!queued) schedule();
      });
    inFlight = started;
    return started;
  }

  const focusListener = deps.window.onDidChangeWindowState((state) => {
    if (state.focused) schedule();
    else clear();
  });

  function refresh(): Promise<void> {
    stale = true;
    if (!active()) {
      render();
      return Promise.resolve();
    }
    if (!focused()) {
      clear();
      return Promise.resolve();
    }
    return poll();
  }

  async function settingsChanged(): Promise<void> {
    const nextEnabled = deps.isEnabled();
    const nextPort = deps.getPort();
    if (nextEnabled === enabled && nextPort === port) return;
    enabled = nextEnabled;
    port = nextPort;
    generation += 1;
    // Off: hidden, no polling. On again, or a new port: hidden until Wisply answers.
    clear();
    snapshot = null;
    render();
    if (enabled) await refresh();
  }

  return {
    refresh,
    settingsChanged,
    report(answer) {
      accept(answer);
      if (!inFlight) schedule();
    },
    get snapshot() {
      return active() ? snapshot : null;
    },
    get scheduled() {
      return timer !== null;
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      clear();
      focusListener.dispose();
      item?.dispose();
      item = null;
    },
  };
}

// --- The menu the item opens ------------------------------------------------

export const MENU = Object.freeze({
  insertQuote: '$(quote) Insert Transcript Quote',
  checkConnection: '$(plug) Check Connection',
  setToken: '$(key) Set Token…',
  storeTokenInKeychain: '$(lock) Store Token in the Mac Keychain…',
  openSetupGuide: '$(book) Open Setup Guide',
  hideStatusItem: '$(eye-closed) Hide Status Item',
});
export type MenuAction = keyof typeof MENU;
export const MENU_TITLE = 'Wisply';

export interface MenuItem extends vscode.QuickPickItem {
  readonly action: MenuAction;
}

/** The menu's items, in order. Store Token in the Mac Keychain… only on macOS. */
export function menuItems(platform: string): MenuItem[] {
  return (Object.keys(MENU) as MenuAction[])
    .filter((action) => action !== 'storeTokenInKeychain' || platform === 'darwin')
    .map((action) => ({ label: MENU[action], action }));
}

type MenuWindow = Pick<typeof vscode.window, 'showQuickPick'>;

/** Shows the menu; resolves the chosen action, or undefined when dismissed. */
export async function pickMenuAction(window: MenuWindow, platform: string): Promise<MenuAction | undefined> {
  const picked = await window.showQuickPick(menuItems(platform), { title: MENU_TITLE, placeHolder: 'Choose a Wisply action' });
  return picked?.action;
}
