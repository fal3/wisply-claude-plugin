// src/status.ts: the status bar item's text, its polling, and the menu it opens.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import {
  LIVE_TOOL, MAX_MISSES, MENU, NOT_SET_UP, POLL_MS, STATUS_ARGUMENTS, STATUS_ITEM_ID, STATUS_PRIORITY, STATUS_TEXT, STATUS_TIMEOUT_MS,
  WARNING_BACKGROUND, createStatusController, isMiss, menuItems, pickMenuAction, pollDelayMs, snapshotFromAnswer, statusText,
} from '../out/test/status.mjs';
import { CONNECTION_TEXT } from '../out/test/sidecar.mjs';
import * as messages from '../src/editor-messages.mjs';
import { createFakeClock } from './fixtures/fake-clock.mjs';
import { FakeThemeColor, createFakeVscode } from './fixtures/fake-vscode.mjs';
import { UNTRUSTED_NOTICE, wisplyResult } from './fixtures/fake-wisply.mjs';

const PORT = 51771;
const SENTINEL = 'SENTINEL-transcript-7f3a';
const RECORDING = Object.freeze({
  state: 'recording', duration_seconds: 724, transcript: SENTINEL, word_count: 1204, speaker_count: 3, memo_id: 'm1',
  agent_recording_control: true,
});
const IDLE = Object.freeze({ state: 'idle', duration_seconds: 0, transcript: '', word_count: 0, speaker_count: 0, agent_recording_control: false });
const live = (payload, options) => ({ kind: 'result', result: wisplyResult(payload, options) });
const toolError = (text) => ({ kind: 'result', result: { content: [{ type: 'text', text }], isError: true } });
const snap = (payload) => snapshotFromAnswer(live(payload), PORT);

test('the text for each state, as the spec shows it', () => {
  assert.deepEqual(statusText(snap(RECORDING)),
    { text: '$(record) Wisply 12:04', tooltip: 'Wisply: recording · 1,204 words · 3 speakers', warning: true });
  assert.deepEqual(statusText(snap({ ...RECORDING, state: 'paused' })),
    { text: '$(debug-pause) Wisply 12:04', tooltip: 'Wisply: paused · 1,204 words · 3 speakers', warning: false });
  assert.deepEqual(statusText(snap(IDLE)), { text: '$(mic) Wisply', tooltip: 'Wisply: not recording', warning: false });
  assert.deepEqual(statusText(snap({ ...IDLE, state: 'rewinding' })), { text: '$(mic) Wisply', tooltip: STATUS_TEXT.unknown, warning: false });
  assert.deepEqual(statusText(snapshotFromAnswer(toolError(messages.SETUP), PORT)),
    { text: '$(key) Wisply', tooltip: CONNECTION_TEXT.setup, warning: false });
  assert.deepEqual(statusText(snapshotFromAnswer(toolError(messages.unavailable(PORT)), PORT)),
    { text: '$(debug-disconnect) Wisply', tooltip: messages.unavailable(PORT), warning: false });
  assert.deepEqual(statusText(snapshotFromAnswer(toolError(messages.notWisply(PORT)), PORT)),
    { text: '$(warning) Wisply', tooltip: messages.notWisply(PORT), warning: false });
});

test('counts: singular, thousands separators, no speakers part without diarization, hours', () => {
  assert.equal(statusText(snap({ ...RECORDING, word_count: 1, speaker_count: 1 })).tooltip, 'Wisply: recording · 1 word · 1 speaker');
  assert.equal(statusText(snap({ ...RECORDING, word_count: 0, speaker_count: 0 })).tooltip, 'Wisply: recording · 0 words');
  assert.equal(statusText(snap({ ...RECORDING, word_count: 1234567 })).tooltip, 'Wisply: recording · 1,234,567 words · 3 speakers');
  assert.equal(statusText(snap({ ...RECORDING, duration_seconds: 3723.9 })).text, '$(record) Wisply 1:02:03');
  assert.equal(statusText(snap({ ...RECORDING, duration_seconds: -5 })).text, '$(record) Wisply 00:00');
});

test('the item never shows recorded speech', () => {
  for (const payload of [RECORDING, { ...RECORDING, state: 'paused' }, IDLE]) {
    const view = statusText(snap(payload));
    assert.doesNotMatch(`${view.text} ${view.tooltip}`, new RegExp(SENTINEL));
  }
});

test('snapshotFromAnswer reads structuredContent, or the JSON text block after Wisply\'s notice', () => {
  const textOnly = { kind: 'result', result: { content: [{ type: 'text', text: UNTRUSTED_NOTICE }, { type: 'text', text: JSON.stringify(RECORDING) }] } };
  assert.deepEqual(snapshotFromAnswer(textOnly, PORT), snap(RECORDING));
  assert.deepEqual({ ...snap(RECORDING) },
    { phase: 'recording', durationSeconds: 724, wordCount: 1204, speakerCount: 3, current: true, problem: '' });
});

test('a build without agent_recording_control is an older Wisply that ignores tail_words', () => {
  const { agent_recording_control: _flag, ...old } = RECORDING;
  assert.equal(snap(old).current, false);
  assert.equal(snap(RECORDING).current, true);
  assert.equal(snap({ ...RECORDING, agent_recording_control: false }).current, true, 'false is still the new payload');
});

test('problems: setup, malformed, unavailable, other tool errors, JSON-RPC errors, sidecar failures, unreadable', () => {
  const at = (answer) => ({ ...snapshotFromAnswer(answer, PORT) });
  assert.equal(at(toolError(messages.SETUP)).phase, 'setup');
  assert.deepEqual([at(toolError(messages.MALFORMED)).phase, at(toolError(messages.MALFORMED)).problem], ['setup', messages.MALFORMED]);
  assert.equal(at(toolError(messages.unavailable(PORT))).phase, 'unavailable');
  assert.equal(at(toolError(messages.unavailable(PORT + 1))).phase, 'problem', 'the text names another port');
  assert.deepEqual([at(toolError(messages.UPDATE_WISPLY)).phase, at(toolError(messages.UPDATE_WISPLY)).problem], ['problem', messages.UPDATE_WISPLY]);
  assert.equal(at(toolError('')).problem, CONNECTION_TEXT.failed);
  assert.deepEqual(at({ kind: 'rpc-error', code: -32602, message: 'Fixed text' }), { ...at({ kind: 'rpc-error', code: 1, message: 'Fixed text' }) });
  assert.equal(at({ kind: 'rpc-error', code: -32602, message: 'Fixed text' }).problem, 'Fixed text');
  assert.equal(at({ kind: 'rpc-error', code: -32602, message: '' }).problem, CONNECTION_TEXT.failed);
  for (const failure of ['timeout', 'exited', 'spawn-failed', 'too-large', 'bad-response']) {
    assert.deepEqual([at({ kind: 'failure', failure }).phase, at({ kind: 'failure', failure }).problem], ['problem', CONNECTION_TEXT.failed]);
  }
  assert.equal(snapshotFromAnswer({ kind: 'failure', failure: 'disposed' }, PORT), null);
  assert.equal(at(live({ memos: [] })).problem, STATUS_TEXT.unreadable);
});

test('poll intervals: 10 s while recording, 30 s idle, 60 s for problems and for builds that ignore tail_words', () => {
  const { agent_recording_control: _flag, ...old } = RECORDING;
  assert.deepEqual({ ...POLL_MS }, { live: 10_000, idle: 30_000, slow: 60_000 });
  assert.equal(pollDelayMs(snap(RECORDING)), 10_000);
  assert.equal(pollDelayMs(snap({ ...RECORDING, state: 'paused' })), 10_000);
  assert.equal(pollDelayMs(snap(IDLE)), 30_000);
  assert.equal(pollDelayMs(snap({ ...IDLE, state: 'rewinding' })), 30_000);
  assert.equal(pollDelayMs(snap(old)), 60_000);
  assert.equal(pollDelayMs(snap({ ...old, state: 'idle' })), 60_000);
  for (const text of [messages.SETUP, messages.unavailable(PORT), messages.UPDATE_WISPLY]) {
    assert.equal(pollDelayMs(snapshotFromAnswer(toolError(text), PORT)), 60_000, text);
  }
});

/** Every text the item showed, in order. */
const vsLogTexts = (item) => item().shownTexts;

/** A controller on a fake window, clock and sidecar call. `answers` are returned in order; then the last one again. */
function harness({ focused = true, enabled = true, answers = [live(RECORDING)], port = PORT, setUp = true } = {}) {
  const vs = createFakeVscode({ focused });
  const clock = createFakeClock();
  const state = { enabled, port, setUp, setUpAsked: 0, calls: [], answers: [...answers], last: answers.at(-1), gate: null };
  const controller = createStatusController({
    window: vs.window,
    ThemeColor: FakeThemeColor,
    alignment: vs.StatusBarAlignment.Right,
    command: 'wisply.statusMenu',
    call: async (tool, args, timeoutMs) => {
      state.calls.push({ tool, args, timeoutMs });
      if (state.gate) await state.gate;
      const next = state.answers.length > 0 ? state.answers.shift() : state.last;
      state.last = next;
      return next;
    },
    getPort: () => state.port,
    isEnabled: () => state.enabled,
    isSetUp: () => {
      state.setUpAsked += 1;
      return typeof state.setUp === 'function' ? state.setUp() : state.setUp;
    },
    timers: clock.timers,
    now: clock.now,
  });
  return { vs, clock, state, controller, item: () => vs.statusItems[0] };
}

test('focused: the first poll shows the item, with id, name, command, side and priority', async (t) => {
  const { vs, state, controller, item } = harness();
  t.after(() => controller.dispose());
  assert.equal(vs.statusItems.length, 0, 'hidden until Wisply answers');
  await controller.refresh();
  assert.deepEqual(state.calls, [{ tool: LIVE_TOOL, args: { ...STATUS_ARGUMENTS }, timeoutMs: STATUS_TIMEOUT_MS }]);
  assert.deepEqual(state.calls[0].args, { tail_words: 1 });
  assert.equal(STATUS_TIMEOUT_MS, 15_000);
  const shown = item();
  assert.deepEqual({ id: shown.id, alignment: shown.alignment, priority: shown.priority, name: shown.name, command: shown.command },
    { id: STATUS_ITEM_ID, alignment: 2, priority: STATUS_PRIORITY, name: 'Wisply', command: 'wisply.statusMenu' });
  assert.equal(STATUS_PRIORITY, 100);
  assert.equal(shown.visible, true);
  assert.equal(shown.text, '$(record) Wisply 12:04');
  assert.equal(shown.tooltip, 'Wisply: recording · 1,204 words · 3 speakers');
  assert.deepEqual(shown.accessibilityInformation, { label: shown.tooltip });
  assert.ok(shown.backgroundColor instanceof FakeThemeColor);
  assert.equal(shown.backgroundColor.id, WARNING_BACKGROUND);
  assert.equal(WARNING_BACKGROUND, 'statusBarItem.warningBackground');
});

test('polls every 10 s while recording, then 30 s once idle; no background color when idle', async (t) => {
  const { clock, state, controller, item } = harness({ answers: [live(RECORDING), live(RECORDING), live(IDLE)] });
  t.after(() => controller.dispose());
  await controller.refresh();
  assert.deepEqual(clock.pending(), [10_000]);
  await clock.advance(9_999);
  assert.equal(state.calls.length, 1);
  await clock.advance(1);
  assert.equal(state.calls.length, 2);
  await clock.advance(10_000);
  assert.equal(state.calls.length, 3);
  assert.equal(item().text, '$(mic) Wisply');
  assert.equal(item().backgroundColor, undefined);
  assert.deepEqual(clock.pending(), [30_000]);
  await clock.advance(30_000);
  assert.equal(state.calls.length, 4);
});

test('60 s while Wisply isn\'t answering, and the item says so', async (t) => {
  const { clock, controller, item } = harness({ answers: [toolError(messages.unavailable(PORT))] });
  t.after(() => controller.dispose());
  await controller.refresh();
  assert.equal(item().text, '$(debug-disconnect) Wisply');
  assert.equal(item().tooltip, messages.unavailable(PORT));
  assert.deepEqual(clock.pending(), [60_000]);
});

test('polling stops while the window isn\'t focused and resumes when it is', async (t) => {
  const { vs, clock, state, controller } = harness();
  t.after(() => controller.dispose());
  await controller.refresh();
  await clock.advance(4_000);
  vs.setFocused(false);
  assert.deepEqual(clock.pending(), [], 'no timer while unfocused');
  await clock.advance(120_000);
  assert.equal(state.calls.length, 1);
  vs.setFocused(true);
  assert.deepEqual(clock.pending(), [0], 'overdue: due at once');
  await clock.advance(0);
  assert.equal(state.calls.length, 2);
  // Focus back before the next poll is due: the poll waits for the rest of the interval.
  await clock.advance(3_000);
  vs.setFocused(false);
  vs.setFocused(true);
  assert.deepEqual(clock.pending(), [7_000]);
});

test('an unfocused window never polls, not even on refresh, until it is focused', async (t) => {
  const { vs, clock, state, controller } = harness({ focused: false });
  t.after(() => controller.dispose());
  await controller.refresh();
  await clock.advance(60_000);
  assert.equal(state.calls.length, 0);
  assert.equal(vs.statusItems.length, 0);
  vs.setFocused(true);
  await clock.advance(0);
  assert.equal(state.calls.length, 1);
  assert.equal(vs.statusItems[0].visible, true);
});

test('wisply.statusBar.enabled off: no item and no polls; on again: hidden until the next answer', async (t) => {
  const { clock, state, controller, item } = harness();
  t.after(() => controller.dispose());
  await controller.refresh();
  state.enabled = false;
  await controller.settingsChanged();
  assert.equal(item().visible, false);
  assert.equal(controller.snapshot, null);
  assert.deepEqual(clock.pending(), []);
  await clock.advance(120_000);
  await controller.refresh();
  assert.equal(state.calls.length, 1);
  state.enabled = true;
  state.gate = Promise.resolve();
  await controller.settingsChanged();
  assert.equal(state.calls.length, 2);
  assert.equal(item().visible, true);
});

test('disabled from the start (or off macOS): nothing is created and nothing is called', async (t) => {
  const { vs, clock, state, controller } = harness({ enabled: false });
  t.after(() => controller.dispose());
  await controller.refresh();
  vs.setFocused(true);
  await clock.advance(120_000);
  assert.equal(state.calls.length, 0);
  assert.equal(vs.statusItems.length, 0);
});

test('a new port hides the item until Wisply answers there; other setting changes don\'t poll', async (t) => {
  const { state, controller, item } = harness();
  t.after(() => controller.dispose());
  await controller.refresh();
  await controller.settingsChanged();
  assert.equal(state.calls.length, 1, 'nothing the item depends on changed');
  let release;
  state.gate = new Promise((resolve) => { release = resolve; });
  state.port = 51772;
  const changed = controller.settingsChanged();
  assert.equal(item().visible, false);
  release();
  await changed;
  assert.equal(state.calls.length, 2);
  assert.equal(item().visible, true);
});

test('an answer to a poll started before the port changed is dropped', async (t) => {
  const { state, controller, item } = harness({ answers: [live(IDLE), live(RECORDING), live(IDLE)] });
  t.after(() => controller.dispose());
  await controller.refresh();
  let release;
  state.gate = new Promise((resolve) => { release = resolve; });
  const before = controller.refresh();
  state.port = 51772;
  const changed = controller.settingsChanged();
  release();
  await Promise.all([before, changed]);
  state.gate = null;
  // The old port's answer (RECORDING) never showed; the new port's (IDLE) did.
  assert.equal(state.calls.length, 3);
  assert.equal(item().text, '$(mic) Wisply');
  assert.equal(vsLogTexts(item).includes('$(record) Wisply 12:04'), false);
});

test('one request at a time: refreshes during a poll queue one more poll, not one each', async (t) => {
  const { state, controller } = harness();
  t.after(() => controller.dispose());
  let release;
  state.gate = new Promise((resolve) => { release = resolve; });
  const first = controller.refresh();
  const second = controller.refresh();
  const third = controller.refresh();
  assert.equal(state.calls.length, 1);
  release();
  state.gate = null;
  await Promise.all([first, second, third]);
  assert.equal(state.calls.length, 2);
});

test('report(): Insert Quote\'s live answer updates the item without a call and restarts the interval', async (t) => {
  const { clock, state, controller, item } = harness({ answers: [live(IDLE)] });
  t.after(() => controller.dispose());
  await controller.refresh();
  await clock.advance(20_000);
  controller.report(live(RECORDING));
  assert.equal(item().text, '$(record) Wisply 12:04');
  assert.equal(state.calls.length, 1);
  assert.deepEqual(clock.pending(), [10_000]);
  controller.report({ kind: 'failure', failure: 'disposed' });
  assert.equal(item().text, '$(record) Wisply 12:04', 'a disposed sidecar says nothing');
});

test('not set up in this editor: a static key item that opens the menu, and nothing is asked', async (t) => {
  const { vs, clock, state, controller, item } = harness({ setUp: false });
  t.after(() => controller.dispose());
  await controller.refresh();
  assert.equal(state.calls.length, 0, 'no helper process, no Keychain read');
  assert.deepEqual({ ...controller.snapshot }, { ...NOT_SET_UP });
  assert.deepEqual({ text: item().text, tooltip: item().tooltip, command: item().command, visible: item().visible },
    { text: '$(key) Wisply', tooltip: STATUS_TEXT.notSetUp, command: 'wisply.statusMenu', visible: true });
  assert.match(STATUS_TEXT.notSetUp, /doesn't contact Wisply or read the Mac Keychain/);
  assert.deepEqual(clock.pending(), [], 'no timer');
  await clock.advance(10 * 60_000);
  assert.equal(state.calls.length, 0);
  // Focus again: it asks whether Wisply was set up meanwhile (another window), still without a call.
  const asked = state.setUpAsked;
  vs.setFocused(false);
  vs.setFocused(true);
  await clock.flush();
  assert.equal(state.setUpAsked, asked + 1);
  assert.equal(state.calls.length, 0);
  // Set up (a token, a check that reached Wisply): the next refresh polls.
  state.setUp = true;
  await controller.refresh();
  assert.equal(state.calls.length, 1);
  assert.equal(item().text, '$(record) Wisply 12:04');
  assert.deepEqual(clock.pending(), [10_000]);
});

test('isSetUp may be async; a rejection or a throw counts as not set up', async (t) => {
  for (const setUp of [() => Promise.reject(new Error('secret storage')), () => { throw new Error('state'); }, () => Promise.resolve(false)]) {
    const { state, controller } = harness({ setUp });
    await controller.refresh();
    assert.equal(state.calls.length, 0);
    assert.equal(controller.snapshot.phase, 'not-set-up');
    controller.dispose();
  }
  const { state, controller } = harness({ setUp: () => Promise.resolve(true) });
  t.after(() => controller.dispose());
  await controller.refresh();
  assert.equal(state.calls.length, 1);
});

test(`after ${3} misses in a row polling pauses; each focus gets one more try; a refresh or an answer starts over`, async (t) => {
  assert.equal(MAX_MISSES, 3);
  const missing = toolError(messages.SETUP);
  const { vs, clock, state, controller, item } = harness({ answers: [missing, missing, missing] });
  t.after(() => controller.dispose());
  await controller.refresh();
  await clock.advance(60_000);
  await clock.advance(60_000);
  assert.equal(state.calls.length, 3);
  assert.equal(controller.paused, true);
  assert.deepEqual(clock.pending(), [], 'no more polls');
  assert.equal(item().text, '$(key) Wisply', 'the item keeps saying what is wrong');
  await clock.advance(30 * 60_000);
  assert.equal(state.calls.length, 3);
  // The window gets focus again: one try, at once.
  vs.setFocused(false);
  vs.setFocused(true);
  assert.deepEqual(clock.pending(), [0]);
  await clock.advance(0);
  assert.equal(state.calls.length, 4);
  assert.deepEqual(clock.pending(), [], 'missed again: paused again');
  // A refresh (a command, a token or a setting change) starts over.
  await controller.refresh();
  assert.equal(state.calls.length, 5);
  assert.equal(controller.paused, false);
  assert.deepEqual(clock.pending(), [60_000]);
  // A recording state resets the count.
  state.last = live(IDLE);
  await clock.advance(60_000);
  assert.equal(item().text, '$(mic) Wisply');
  assert.equal(controller.paused, false);
  for (const text of [messages.SETUP, messages.unavailable(PORT), messages.UPDATE_WISPLY]) {
    assert.equal(isMiss(snapshotFromAnswer(toolError(text), PORT)), true, text);
  }
  assert.equal(isMiss(snap(IDLE)), false);
  assert.equal(isMiss(snap({ ...IDLE, state: 'rewinding' })), false);
});

test('dispose: the item goes, timers stop, and a late answer changes nothing', async (t) => {
  const { clock, state, controller, item } = harness();
  await controller.refresh();
  let release;
  state.gate = new Promise((resolve) => { release = resolve; });
  await clock.advance(10_000);
  controller.dispose();
  controller.dispose();
  release();
  await clock.flush();
  assert.equal(item().disposed, true);
  assert.deepEqual(clock.pending(), []);
  assert.equal(controller.snapshot, null);
  t.diagnostic(`calls: ${state.calls.length}`);
});

test('the menu: six actions on macOS in order, without the Keychain one elsewhere', async () => {
  assert.deepEqual(menuItems('darwin').map((item) => item.label), [
    '$(quote) Insert Transcript Quote', '$(plug) Check Connection', '$(key) Set Token…',
    '$(lock) Store Token in the Mac Keychain…', '$(book) Open Setup Guide', '$(eye-closed) Hide Status Item',
  ]);
  assert.deepEqual(menuItems('linux').map((item) => item.action),
    ['insertQuote', 'checkConnection', 'setToken', 'openSetupGuide', 'hideStatusItem']);
  assert.deepEqual(Object.keys(MENU), ['insertQuote', 'checkConnection', 'setToken', 'storeTokenInKeychain', 'openSetupGuide', 'hideStatusItem']);
  const vs = createFakeVscode({ picks: ['checkConnection', undefined] });
  assert.equal(await pickMenuAction(vs.window, 'darwin'), 'checkConnection');
  assert.equal(await pickMenuAction(vs.window, 'darwin'), undefined);
  assert.equal(vs.log.find((entry) => entry.kind === 'quickPick').options.title, 'Wisply');
});

// --- Through the extension: the real bundle, a synthetic Wisply and the menu ---

const ROOT = new URL('..', import.meta.url).pathname;

async function until(predicate, what, ms = 8000) {
  const deadline = Date.now() + ms;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => { setTimeout(resolve, 10); });
  }
}

async function activateFocused(t, { wisplyPort, platform = 'darwin', picks = [], answers = {}, secrets, state = {}, spawned } = {}) {
  const { activateExtension } = await import('../out/test/extension.mjs');
  const { createFakeContext, createFakeSecrets } = await import('./fixtures/fake-vscode.mjs');
  const { FAKE_TOKENS } = await import('./fixtures/fake-vscode.mjs');
  const { spawn } = await import('node:child_process');
  const vs = createFakeVscode({ focused: true, picks, answers, config: wisplyPort ? { port: { globalValue: wisplyPort } } : {} });
  const store = secrets ?? createFakeSecrets({ 'wisply.mcpToken': FAKE_TOKENS.connector });
  const clock = createFakeClock();
  const context = createFakeContext({ root: ROOT, secrets: store, state: { 'wisply.welcomeShown': true, ...state } });
  const activation = activateExtension(vs, context, {
    execPath: process.execPath, platform, hostEnv: { PATH: process.env.PATH, HOME: process.env.HOME }, timers: clock.timers, now: clock.now,
    // Records every process the extension starts (the helper), then starts it for real.
    ...(spawned ? { spawn: (command, args, options) => { spawned.push(args); return spawn(command, args, options); } } : {}),
  });
  t.after(() => activation.dispose());
  return { vs, clock, store, context };
}

test('end to end: activation in a focused window shows the recording, read with tail_words 1 through the bundle', async (t) => {
  const { startFakeWisply } = await import('./fixtures/fake-wisply.mjs');
  const { FAKE_TOKENS } = await import('./fixtures/fake-vscode.mjs');
  const wisply = await startFakeWisply(t, { tools: { get_live_transcript: () => wisplyResult(RECORDING) } });
  const { vs, clock } = await activateFocused(t, { wisplyPort: wisply.port });
  await until(() => vs.statusItems[0]?.visible, 'the status item');
  assert.equal(vs.statusItems[0].text, '$(record) Wisply 12:04');
  assert.equal(vs.statusItems[0].command, 'wisply.statusMenu');
  assert.deepEqual(wisply.seen.calls.map((call) => call.message.params), [{ name: 'get_live_transcript', arguments: { tail_words: 1 } }]);
  assert.equal(wisply.seen.calls[0].authorization, `Bearer ${FAKE_TOKENS.connector}`);
  assert.ok(wisply.seen.challenges.every((challenge) => challenge.authorization === undefined));
  assert.deepEqual(clock.pending(), [10_000]);
  assert.doesNotMatch(JSON.stringify(vs.log), new RegExp(SENTINEL), 'no recorded speech reaches the UI');
});

test('end to end: never set up, the item asks nothing (no helper process, no Keychain); a new token polls at once', async (t) => {
  const { startFakeWisply } = await import('./fixtures/fake-wisply.mjs');
  const { FAKE_TOKENS, createFakeSecrets } = await import('./fixtures/fake-vscode.mjs');
  const wisply = await startFakeWisply(t, { tools: { get_live_transcript: () => wisplyResult(IDLE) } });
  const secrets = createFakeSecrets();
  const spawned = [];
  const { vs } = await activateFocused(t, { wisplyPort: wisply.port, secrets, spawned });
  await until(() => vs.statusItems[0]?.visible, 'the static item');
  assert.equal(vs.statusItems[0].text, '$(key) Wisply');
  assert.equal(vs.statusItems[0].tooltip, STATUS_TEXT.notSetUp);
  await new Promise((resolve) => { setTimeout(resolve, 100); });
  assert.deepEqual(spawned, [], 'no helper process started, so nothing read the Keychain');
  assert.equal(wisply.seen.challenges.length + wisply.seen.calls.length, 0);
  await secrets.store('wisply.mcpToken', FAKE_TOKENS.connector);
  await until(() => vs.statusItems[0].text === '$(mic) Wisply', 'the poll with the new token');
  assert.equal(wisply.seen.calls.length, 1);
  assert.equal(spawned.length, 1);
});

// No token in secret storage, so the connector reads the Keychain on a Mac: run off macOS only, like bundle.test.mjs.
const wouldTouchKeychain = process.platform === 'darwin' || existsSync('/usr/bin/security');
test('end to end: once Wisply was reached from this editor (Cursor: the Keychain), the item asks without a stored token',
  { skip: wouldTouchKeychain }, async (t) => {
    const { startFakeWisply } = await import('./fixtures/fake-wisply.mjs');
    const { createFakeSecrets } = await import('./fixtures/fake-vscode.mjs');
    const wisply = await startFakeWisply(t, { tools: { get_live_transcript: () => wisplyResult(IDLE) } });
    const { vs } = await activateFocused(t, { wisplyPort: wisply.port, secrets: createFakeSecrets(), state: { 'wisply.reachedWisply': true } });
    await until(() => vs.statusItems[0]?.visible && vs.statusItems[0].text !== '$(key) Wisply', 'the first answer');
    // Off macOS without a token the connector says there's nothing to connect to.
    assert.equal(vs.statusItems[0].text, '$(warning) Wisply');
    assert.equal(vs.statusItems[0].tooltip, messages.notMac(process.platform));
  });

test('end to end: Check Connection that reaches Wisply records it; Forget Token clears it', async (t) => {
  const { startFakeWisply } = await import('./fixtures/fake-wisply.mjs');
  const wisply = await startFakeWisply(t, { tools: { get_live_transcript: () => wisplyResult(IDLE) } });
  const { vs, context } = await activateFocused(t, { wisplyPort: wisply.port });
  await vs.commands.run('wisply.checkConnection');
  assert.equal(context.globalState.get('wisply.reachedWisply'), true);
  await vs.commands.run('wisply.forgetToken');
  assert.equal(context.globalState.get('wisply.reachedWisply'), false);
  await until(() => vs.statusItems[0]?.text === '$(key) Wisply' && vs.statusItems[0].tooltip === STATUS_TEXT.notSetUp,
    'the static item again');
});

test('the menu: Hide Status Item turns the user setting off, hides the item, and Undo brings it back', async (t) => {
  const { startFakeWisply } = await import('./fixtures/fake-wisply.mjs');
  const wisply = await startFakeWisply(t, { tools: { get_live_transcript: () => wisplyResult(IDLE) } });
  const { vs } = await activateFocused(t, { wisplyPort: wisply.port, picks: ['hideStatusItem'], answers: { 'is hidden': 'Undo' } });
  await until(() => vs.statusItems[0]?.visible, 'the status item');
  await vs.commands.run('wisply.statusMenu');
  assert.deepEqual(vs.configuration.updates, [
    { key: 'statusBar.enabled', value: false, target: 1 },
    { key: 'statusBar.enabled', value: true, target: 1 },
  ]);
  const hidden = vs.log.find((entry) => entry.kind === 'info' && entry.text.includes('is hidden'));
  assert.deepEqual(hidden.buttons, ['Undo']);
  assert.ok(vs.log.some((entry) => entry.kind === 'statusHide'));
  await until(() => vs.statusItems[0].visible, 'the item again after Undo');
  assert.equal(wisply.seen.calls.length, 2);
});

test('the menu runs the chosen command; dismissing it does nothing', async (t) => {
  const { startFakeWisply } = await import('./fixtures/fake-wisply.mjs');
  const wisply = await startFakeWisply(t, { tools: { get_live_transcript: () => wisplyResult(IDLE) } });
  const { vs } = await activateFocused(t, { wisplyPort: wisply.port, picks: ['openSetupGuide', undefined] });
  await until(() => vs.statusItems[0]?.visible, 'the status item');
  await vs.commands.run('wisply.statusMenu');
  assert.ok(vs.log.some((entry) => entry.kind === 'openExternal' && entry.uri === 'https://www.wisply.ai/docs/mcp/install#vscode'));
  const before = vs.log.length;
  await vs.commands.run('wisply.statusMenu');
  assert.deepEqual(vs.log.slice(before).map((entry) => entry.kind), ['quickPick']);
});

test('off macOS there is no status item, even in a focused window', async (t) => {
  const { vs, clock } = await activateFocused(t, { platform: 'linux' });
  await clock.advance(120_000);
  await new Promise((resolve) => { setTimeout(resolve, 50); });
  assert.equal(vs.statusItems.length, 0);
  assert.deepEqual(clock.pending(), []);
});
