// src/quote.ts: formatting, the live and search paths of Wisply: Insert
// Transcript Quote, and the command end to end through the real bundle.
import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import {
  LIVE_TIMEOUT_MS, LIVE_TOOL, MAX_QUOTE_CHARS, QUOTE_TEXT, SEARCH_LIMIT, SEARCH_TIMEOUT_MS, SEARCH_TOOL, clip, formatQuote,
  insertQuote, lastWords, matchItems, parseMatches, placeQuote, plainLabel, problemReport, quoteDate,
} from '../out/test/quote.mjs';
import { CONNECTION_TEXT } from '../out/test/sidecar.mjs';
import * as messages from '../src/editor-messages.mjs';
import { FAKE_TOKENS, createFakeContext, createFakeEditor, createFakeSecrets, createFakeVscode } from './fixtures/fake-vscode.mjs';
import { startFakeWisply, wisplyResult } from './fixtures/fake-wisply.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const PORT = 51771;
const TZ = 'America/New_York';
const EM_DASH = '—';
const RECORDING = Object.freeze({
  state: 'recording', duration_seconds: 95, transcript: 'so the plan is to ship on Friday and tell support first',
  word_count: 12, speaker_count: 2, memo_id: 'm-live', agent_recording_control: true,
});
const IDLE = Object.freeze({ state: 'idle', duration_seconds: 0, transcript: '', word_count: 0, speaker_count: 0, agent_recording_control: true });
const MATCHES = Object.freeze({
  query: 'budget', count: 2, matches: [
    { memo_id: 'a', title: 'Q3 planning', created_at: '2026-10-20T15:30:00Z', excerpt: '…we agreed the budget stays flat…', matched_field: 'transcript' },
    { memo_id: 'b', title: 'Standup', created_at: '2026-10-21T02:30:00Z', excerpt: 'budget review moved to Monday', matched_field: 'transcript' },
  ],
});
const live = (payload) => ({ kind: 'result', result: wisplyResult(payload) });
const toolError = (text) => ({ kind: 'result', result: { content: [{ type: 'text', text }], isError: true } });

// --- Pure parts ---------------------------------------------------------------

test('formatQuote: Markdown and plain, as the spec shows them', () => {
  const input = { text: 'we ship Friday', title: 'Q3 planning', date: '2026-10-20' };
  assert.equal(formatQuote({ ...input, style: 'markdown' }), `> we ship Friday\n>\n> ${EM_DASH} Wisply, "Q3 planning", 2026-10-20`);
  assert.equal(formatQuote({ ...input, style: 'plain' }), '"we ship Friday" (Wisply, Q3 planning, 2026-10-20)');
  assert.equal(formatQuote({ ...input, date: '', style: 'markdown' }), `> we ship Friday\n>\n> ${EM_DASH} Wisply, "Q3 planning"`);
  assert.equal(formatQuote({ ...input, date: '', style: 'plain' }), '"we ship Friday" (Wisply, Q3 planning)');
  assert.equal(formatQuote({ ...input, title: '  ', style: 'plain' }), '"we ship Friday" (Wisply, Untitled memo, 2026-10-20)');
});

test('formatQuote: speech and titles are one line of visible text; nothing to quote is null', () => {
  const text = 'line one\nline two\r\n\u001b[31mred\u001b[0m \u202Eevil\u200B zero\u0007';
  const quote = formatQuote({ text, title: 'A\ntitle\u0000', date: '2026-10-20', style: 'markdown' });
  assert.equal(quote, `> line one line two red evil zero\n>\n> ${EM_DASH} Wisply, "A title", 2026-10-20`);
  assert.equal(quote.split('\n').length, 3, 'a line break in the speech never ends the block quote');
  for (const empty of ['', '   ', '\u200B\u200B', null, undefined, 42]) {
    assert.equal(formatQuote({ text: empty, title: 'x', date: '', style: 'markdown' }), null, String(empty));
  }
  const long = formatQuote({ text: 'w '.repeat(5000), title: 't'.repeat(500), date: '', style: 'plain' });
  assert.ok(long.length < MAX_QUOTE_CHARS + 260);
  assert.ok(long.includes('…'));
  assert.equal(clip('abcdef', 4), 'abc…');
  assert.equal(clip('abc', 4), 'abc');
});

test('quoteDate: YYYY-MM-DD in the editor\'s time zone; anything invalid is empty', () => {
  assert.equal(quoteDate('2026-10-21T02:30:00Z', 'UTC'), '2026-10-21');
  assert.equal(quoteDate('2026-10-21T02:30:00Z', TZ), '2026-10-20');
  assert.equal(quoteDate(new Date(Date.UTC(2026, 0, 5, 12)), 'UTC'), '2026-01-05');
  assert.match(quoteDate('2026-10-21T12:00:00Z'), /^2026-10-2[01]$/);
  assert.equal(quoteDate('2026-10-21T12:00:00Z', 'Not/AZone'), quoteDate('2026-10-21T12:00:00Z'));
  for (const value of ['', 'yesterday', null, undefined, {}, Number.NaN]) assert.equal(quoteDate(value, 'UTC'), '', String(value));
});

test('lastWords: the last N words, with an ellipsis when earlier words were left out', () => {
  assert.equal(lastWords('one two three four five', 3), '… three four five');
  assert.equal(lastWords('one two three', 3), 'one two three');
  assert.equal(lastWords('one two three', 10), 'one two three');
  // Wisply sent only the tail (tail_words), but word_count counts the whole transcript.
  assert.equal(lastWords('three four', 2, 4), '… three four');
  assert.equal(lastWords('a\n\nb\tc\u0007', 5), 'a b c');
  assert.equal(lastWords('', 5), null);
  assert.equal(lastWords('\u200B', 5), null);
  assert.equal(lastWords(undefined, 5), null);
  const huge = lastWords(`${'x'.repeat(5000)} end`, 400);
  assert.ok(huge.length <= MAX_QUOTE_CHARS);
  assert.ok(huge.startsWith('… '));
});

test('placeQuote: a Markdown quote is its own block; a plain quote goes in as it is', () => {
  assert.equal(placeQuote('> q', 'markdown', true), '> q\n\n');
  assert.equal(placeQuote('> q', 'markdown', false), '\n\n> q\n\n');
  assert.equal(placeQuote('"q" (Wisply, t)', 'plain', false), '"q" (Wisply, t)');
});

test('parseMatches: structured or text payloads, sanitized, dated, empty excerpts left out', () => {
  assert.deepEqual(parseMatches(wisplyResult(MATCHES), TZ), [
    { memoId: 'a', title: 'Q3 planning', date: '2026-10-20', excerpt: '…we agreed the budget stays flat…' },
    { memoId: 'b', title: 'Standup', date: '2026-10-20', excerpt: 'budget review moved to Monday' },
  ]);
  const { structuredContent: _structured, ...textOnly } = wisplyResult(MATCHES);
  assert.deepEqual(parseMatches(textOnly, TZ), parseMatches(wisplyResult(MATCHES), TZ));
  const odd = wisplyResult({ matches: [null, 'x', { excerpt: '  ' }, { title: 'T\u0007', excerpt: 'hit\nthere', created_at: 'nope' }] });
  assert.deepEqual(parseMatches(odd, TZ), [{ memoId: '', title: 'T', date: '', excerpt: 'hit there' }]);
  assert.deepEqual(parseMatches(wisplyResult({ matches: [] })), []);
  assert.equal(parseMatches(wisplyResult({ memos: [] })), null);
});

test('match items: title, date, excerpt; speech can\'t draw icons', () => {
  const items = matchItems([{ memoId: 'a', title: '$(alert) Q3', date: '2026-10-20', excerpt: `${'e'.repeat(300)} $(zap)` }]);
  assert.equal(items[0].label, '$ (alert) Q3');
  assert.equal(items[0].description, '2026-10-20');
  assert.ok(items[0].detail.length <= 240);
  assert.doesNotMatch(JSON.stringify(items.map(({ label, detail }) => ({ label, detail }))), /\$\(/);
  assert.equal(plainLabel('$(a)$(b)'), '$ (a)$ (b)');
});

test('problemReport: the same steps as Check Connection', () => {
  assert.deepEqual(problemReport(toolError(messages.SETUP), PORT), { kind: 'setup', text: CONNECTION_TEXT.setup });
  assert.deepEqual(problemReport(toolError(messages.unavailable(PORT)), PORT), { kind: 'problem', text: messages.unavailable(PORT) });
  assert.deepEqual(problemReport({ kind: 'failure', failure: 'timeout' }, PORT), { kind: 'problem', text: CONNECTION_TEXT.failed });
  assert.deepEqual(problemReport(live(IDLE), PORT), { kind: 'problem', text: QUOTE_TEXT.unreadable });
});

// --- The command with a fake editor and a fake sidecar ---------------------------

function run({ answers = [], platform = 'darwin', editor = createFakeEditor(), noEditor = false, inputs = [], picks = [], words = 80,
  format = 'markdown' } = {}) {
  const vs = createFakeVscode({ inputs, picks, editor: noEditor ? undefined : editor });
  const calls = [];
  const problems = [];
  const liveAnswers = [];
  const queue = [...answers];
  const outcome = insertQuote({
    window: vs.window,
    call: async (tool, args, timeoutMs) => {
      calls.push({ tool, args, timeoutMs });
      return queue.shift() ?? { kind: 'failure', failure: 'exited' };
    },
    getSettings: () => ({ port: PORT, quoteWords: words, quoteFormat: format }),
    platform,
    presentProblem: (report) => { problems.push(report); },
    onLiveAnswer: (answer) => { liveAnswers.push(answer); },
    progressLocation: vs.ProgressLocation.Notification,
    now: () => new Date('2026-10-22T18:00:00Z'),
    timeZone: TZ,
  });
  return { vs, editor, calls, problems, liveAnswers, outcome };
}

test('while recording: the last N words, read fresh, at the cursor, in one edit', async () => {
  const { editor, calls, outcome, liveAnswers, vs } = run({ answers: [live(RECORDING)], words: 5 });
  assert.equal(await outcome, 'inserted-live');
  assert.deepEqual(calls, [{ tool: LIVE_TOOL, args: { tail_words: 5 }, timeoutMs: LIVE_TIMEOUT_MS }]);
  assert.equal(LIVE_TIMEOUT_MS, 15_000);
  assert.equal(liveAnswers.length, 1, 'the status bar item gets the answer');
  assert.equal(editor.edits.length, 1);
  assert.equal(editor.text, `> … tell support first\n>\n> ${EM_DASH} Wisply, "Live recording", 2026-10-22\n\n`
    .replace('… tell support first', '… Friday and tell support first'));
  assert.equal(vs.log.some((entry) => entry.kind === 'inputBox'), false, 'no search while recording');
});

test('while paused it quotes too; plain format; nothing said yet', async () => {
  const paused = run({ answers: [live({ ...RECORDING, state: 'paused' })], words: 400, format: 'plain' });
  assert.equal(await paused.outcome, 'inserted-live');
  assert.equal(paused.editor.text, `"${RECORDING.transcript}" (Wisply, Live recording, 2026-10-22)`);
  const empty = run({ answers: [live({ ...RECORDING, transcript: ' ', word_count: 0 })] });
  assert.equal(await empty.outcome, 'nothing-yet');
  assert.ok(empty.vs.log.some((entry) => entry.kind === 'info' && entry.text === QUOTE_TEXT.nothingYet));
  assert.equal(empty.editor.edits.length, 0);
});

test('not recording: search, pick, insert the excerpt', async () => {
  const { editor, calls, outcome, vs } = run({ answers: [live(IDLE), live(MATCHES)], inputs: ['  budget  '], picks: [(items) => items[1]] });
  assert.equal(await outcome, 'inserted-search');
  assert.deepEqual(calls[1], { tool: SEARCH_TOOL, args: { query: 'budget', limit: SEARCH_LIMIT }, timeoutMs: SEARCH_TIMEOUT_MS });
  assert.equal(SEARCH_LIMIT, 10);
  const input = vs.log.find((entry) => entry.kind === 'inputBox');
  assert.equal(input.options.prompt, 'Search your memos');
  assert.ok(vs.log.some((entry) => entry.kind === 'progress' && entry.title === QUOTE_TEXT.searching));
  const pick = vs.log.find((entry) => entry.kind === 'quickPick');
  assert.deepEqual(pick.items.map((item) => [item.label, item.description, item.detail]), [
    ['Q3 planning', '2026-10-20', '…we agreed the budget stays flat…'],
    ['Standup', '2026-10-20', 'budget review moved to Monday'],
  ]);
  assert.equal(pick.options.matchOnDetail, true);
  assert.equal(editor.text, `> budget review moved to Monday\n>\n> ${EM_DASH} Wisply, "Standup", 2026-10-20\n\n`);
});

test('search: cancelled or blank queries, no matches, a dismissed pick', async () => {
  const cancelled = run({ answers: [live(IDLE)], inputs: [undefined] });
  assert.equal(await cancelled.outcome, 'cancelled');
  assert.equal(cancelled.calls.length, 1);
  const blank = run({ answers: [live(IDLE)], inputs: ['   '] });
  assert.equal(await blank.outcome, 'cancelled');
  assert.equal(blank.calls.length, 1);
  const none = run({ answers: [live(IDLE), live({ query: 'x', matches: [], count: 0 })], inputs: ['zebra\u0007'] });
  assert.equal(await none.outcome, 'no-matches');
  assert.ok(none.vs.log.some((entry) => entry.kind === 'info' && entry.text === 'No Wisply memo matches "zebra".'));
  const dismissed = run({ answers: [live(IDLE), live(MATCHES)], inputs: ['budget'], picks: [undefined] });
  assert.equal(await dismissed.outcome, 'cancelled');
  assert.equal(dismissed.editor.edits.length, 0);
});

test('problems go to the extension\'s presenter, with the same steps as Check Connection', async () => {
  const setup = run({ answers: [toolError(messages.SETUP)] });
  assert.equal(await setup.outcome, 'problem');
  assert.deepEqual(setup.problems, [{ kind: 'setup', text: CONNECTION_TEXT.setup }]);
  assert.equal(setup.vs.log.some((entry) => entry.kind === 'inputBox'), false);
  const offline = run({ answers: [live(IDLE), toolError(messages.unavailable(PORT))], inputs: ['budget'] });
  assert.equal(await offline.outcome, 'problem');
  assert.deepEqual(offline.problems, [{ kind: 'problem', text: messages.unavailable(PORT) }]);
  const unreadable = run({ answers: [live({ memos: [] })] });
  assert.equal(await unreadable.outcome, 'problem');
  assert.deepEqual(unreadable.problems, [{ kind: 'problem', text: QUOTE_TEXT.unreadable }]);
  const notSearch = run({ answers: [live(IDLE), live({ memos: [] })], inputs: ['budget'] });
  assert.equal(await notSearch.outcome, 'problem');
  assert.deepEqual(notSearch.problems, [{ kind: 'problem', text: QUOTE_TEXT.unreadable }]);
  const failed = run({ answers: [{ kind: 'failure', failure: 'timeout' }] });
  assert.equal(await failed.outcome, 'problem');
  assert.deepEqual(failed.problems, [{ kind: 'problem', text: CONNECTION_TEXT.failed }]);
});

test('no editor, not a Mac: nothing is called', async () => {
  const noEditor = run({ noEditor: true, answers: [live(RECORDING)] });
  assert.equal(await noEditor.outcome, 'no-editor');
  assert.equal(noEditor.calls.length, 0);
  assert.ok(noEditor.vs.log.some((entry) => entry.kind === 'info' && entry.text === QUOTE_TEXT.noEditor));
  const linux = run({ platform: 'linux', answers: [live(RECORDING)] });
  assert.equal(await linux.outcome, 'not-mac');
  assert.equal(linux.calls.length, 0);
  assert.ok(linux.vs.log.some((entry) => entry.kind === 'warning' && entry.text === messages.notMac('linux')));
});

test('every cursor gets the quote, mid-line Markdown starts a new paragraph, all in one edit (one Undo)', async () => {
  const editor = createFakeEditor({
    lines: ['Notes: ', 'end'],
    selections: [
      { start: { line: 0, character: 7 }, end: { line: 0, character: 7 } },
      { start: { line: 1, character: 0 }, end: { line: 1, character: 3 } },
    ],
  });
  const { outcome } = run({ editor, answers: [live({ ...RECORDING, transcript: 'hello there', word_count: 2 })] });
  assert.equal(await outcome, 'inserted-live');
  assert.equal(editor.edits.length, 1);
  assert.equal(editor.edits[0].length, 2);
  const quote = `> hello there\n>\n> ${EM_DASH} Wisply, "Live recording", 2026-10-22`;
  assert.equal(editor.text, `Notes: \n\n${quote}\n\n\n${quote}\n\n`);
});

test('an editor that refuses the edit, or closed meanwhile', async () => {
  const readOnly = run({ editor: createFakeEditor({ accepts: false }), answers: [live(RECORDING)] });
  assert.equal(await readOnly.outcome, 'not-inserted');
  assert.ok(readOnly.vs.log.some((entry) => entry.kind === 'warning' && entry.text === QUOTE_TEXT.notInserted));
  const closing = createFakeEditor();
  closing.document.isClosed = true;
  const closed = run({ editor: closing, answers: [live(RECORDING)] });
  assert.equal(await closed.outcome, 'editor-closed');
  assert.equal(closing.edits.length, 0);
});

// --- End to end: the command, the sidecar, the real bundle and a synthetic Wisply ---

async function activateAgainst(t, wisply, { editor, inputs = [], picks = [], config = {} } = {}) {
  const { activateExtension } = await import('../out/test/extension.mjs');
  const vs = createFakeVscode({ config: { port: { globalValue: wisply.port }, ...config }, editor, inputs, picks });
  const context = createFakeContext({ root: ROOT, secrets: createFakeSecrets({ 'wisply.mcpToken': FAKE_TOKENS.connector }),
    state: { 'wisply.welcomeShown': true } });
  const activation = activateExtension(vs, context, {
    execPath: process.execPath, platform: 'darwin', hostEnv: { PATH: process.env.PATH, HOME: process.env.HOME },
  });
  t.after(() => activation.dispose());
  return vs;
}

test('end to end: while recording, Insert Transcript Quote quotes the live transcript through the bundle', async (t) => {
  const wisply = await startFakeWisply(t, { tools: { get_live_transcript: () => wisplyResult(RECORDING) } });
  const editor = createFakeEditor();
  const vs = await activateAgainst(t, wisply, { editor, config: { 'quote.words': { globalValue: 10 } } });
  await vs.commands.run('wisply.insertQuote');
  // The synthetic Wisply ignores tail_words, like builds before the recording-control token: the extension keeps the last 10.
  assert.match(editor.text, /^> … plan is to ship on Friday and tell support first\n>\n> — Wisply, "Live recording", \d{4}-\d{2}-\d{2}\n\n$/);
  assert.deepEqual(wisply.seen.calls.map((call) => call.message.params), [{ name: 'get_live_transcript', arguments: { tail_words: 10 } }]);
  assert.equal(wisply.seen.calls[0].authorization, `Bearer ${FAKE_TOKENS.connector}`, 'the child sent it, after the identity check');
  assert.ok(wisply.seen.challenges.every((challenge) => challenge.authorization === undefined));
});

test('end to end: not recording, it searches and inserts the picked excerpt', async (t) => {
  const wisply = await startFakeWisply(t, {
    tools: { get_live_transcript: () => wisplyResult(IDLE), search_transcripts: () => wisplyResult(MATCHES) },
  });
  const editor = createFakeEditor();
  const vs = await activateAgainst(t, wisply, { editor, inputs: ['budget'], picks: [(items) => items[0]],
    config: { 'quote.format': { globalValue: 'plain' } } });
  await vs.commands.run('wisply.insertQuote');
  assert.match(editor.text, /^"…we agreed the budget stays flat…" \(Wisply, Q3 planning, 2026-10-2[01]\)$/);
  assert.deepEqual(wisply.seen.calls.map((call) => call.message.params.name), ['get_live_transcript', 'search_transcripts']);
  assert.deepEqual(wisply.seen.calls[1].message.params.arguments, { query: 'budget', limit: 10 });
});
