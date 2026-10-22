// Wisply: Insert Transcript Quote.
//
// While a recording is in progress, it puts the last `wisply.quote.words`
// words of the live transcript at the cursor, read fresh with
// `get_live_transcript {"tail_words": N}`. Otherwise it asks "Search your
// memos", calls `search_transcripts {query, limit: 10}`, shows the matches
// (title · date · excerpt) and puts the chosen excerpt at the cursor. Both
// calls go through the read-only sidecar (src/sidecar.ts), like the status
// bar's, so the extension host never sends the token.
//
// Format (`wisply.quote.format`):
//   markdown (default)   > {text}
//                        >
//                        > — Wisply, "{title}", {date}
//   plain                "{text}" (Wisply, {title}, {date})
//
// Recorded speech and titles are untrusted text. They pass through the
// plugin's sanitizeSpeech (vendor/shared.mjs: terminal escapes, control and
// invisible characters removed, whitespace folded to single spaces), so a
// quote is always one line of visible text inside its block. Every insert is
// one editor.edit call, so a single Undo removes it.
import type * as vscode from 'vscode';
import { parseLiveTranscript, sanitizeSpeech } from '../vendor/shared.mjs';
import { notMac } from './editor-messages.mjs';
import { isObject, payloadOf, successfulResult } from './results';
import { describeConnection } from './sidecar';
import type { ConnectionReport, SidecarAnswer } from './sidecar';
import type { QuoteFormat } from './settings';

export const LIVE_TOOL = 'get_live_transcript';
export const SEARCH_TOOL = 'search_transcripts';
export const SEARCH_LIMIT = 10;
/** The connector gives get_live_transcript 5 s and the identity check 3 s. */
export const LIVE_TIMEOUT_MS = 15_000;
/** The connector gives other tools 30 s. */
export const SEARCH_TIMEOUT_MS = 40_000;
export const MAX_QUOTE_CHARS = 4000;
export const MAX_TITLE_CHARS = 200;
/** How much of an excerpt the match list shows. */
export const MAX_DETAIL_CHARS = 240;
const ELLIPSIS = '…';

export const QUOTE_TEXT = Object.freeze({
  title: 'Wisply: Insert Transcript Quote',
  noEditor: 'Open a file and put the cursor where the quote should go, then run Wisply: Insert Transcript Quote again.',
  nothingYet: 'Wisply is recording, but nothing has been transcribed yet. Try again in a moment.',
  searchPrompt: 'Search your memos',
  searchPlaceholder: 'A word or phrase from a recording',
  searching: 'Searching your Wisply memos…',
  pickPlaceholder: 'Choose the excerpt to insert',
  noMatches: (query: string) => `No Wisply memo matches "${query}".`,
  unreadable: "Wisply answered, but not in a way this extension can read. Update Wisply and the Wisply extension.",
  notInserted: "The quote wasn't inserted: this editor doesn't accept changes.",
  editorClosed: 'The editor closed before the quote was ready, so nothing was inserted.',
  liveTitle: 'Live recording',
  untitled: 'Untitled memo',
});

/** Cuts a text to `max` characters, ending with an ellipsis when it was longer. */
export function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, Math.max(0, max - 1)).trimEnd()}${ELLIPSIS}`;
}

/**
 * A date as YYYY-MM-DD in the given time zone (default: the editor's), or ''
 * for anything that isn't a valid date.
 */
export function quoteDate(value: unknown, timeZone?: string): string {
  const date = value instanceof Date ? value : typeof value === 'string' || typeof value === 'number' ? new Date(value) : null;
  if (!date || Number.isNaN(date.getTime())) return '';
  let format: Intl.DateTimeFormat;
  try {
    format = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' });
  } catch {
    format = new Intl.DateTimeFormat('en-CA', { year: 'numeric', month: '2-digit', day: '2-digit' });
  }
  const parts = Object.fromEntries(format.formatToParts(date).map((part) => [part.type, part.value]));
  return parts.year && parts.month && parts.day ? `${parts.year}-${parts.month}-${parts.day}` : '';
}

export interface QuoteInput {
  readonly text: unknown;
  readonly title: unknown;
  /** YYYY-MM-DD, or '' when unknown. */
  readonly date: string;
  readonly style: QuoteFormat;
}

/** The quote as it is inserted (without surrounding line breaks); null when there is nothing to quote. */
export function formatQuote({ text, title, date, style }: QuoteInput): string | null {
  const body = clip(sanitizeSpeech(text), MAX_QUOTE_CHARS);
  if (!body) return null;
  const name = clip(sanitizeSpeech(title), MAX_TITLE_CHARS) || QUOTE_TEXT.untitled;
  const when = sanitizeSpeech(date);
  if (style === 'plain') return `"${body}" (Wisply, ${name}${when ? `, ${when}` : ''})`;
  return `> ${body}\n>\n> — Wisply, "${name}"${when ? `, ${when}` : ''}`;
}

/**
 * The quote placed at one selection. A Markdown quote is a block of its own:
 * it starts on a new paragraph when the selection starts mid-line, and a
 * blank line ends it, so the text after it isn't pulled into the quote. A
 * plain quote goes in as it is.
 */
export function placeQuote(quote: string, style: QuoteFormat, atLineStart: boolean): string {
  if (style === 'plain') return quote;
  return `${atLineStart ? '' : '\n\n'}${quote}\n\n`;
}

/**
 * The last `count` words of a transcript, after sanitizing; a leading
 * ellipsis marks that earlier words were left out. `totalWords` is Wisply's
 * word_count, which counts the whole transcript even when only its tail was
 * sent. null when there are no words.
 */
export function lastWords(transcript: unknown, count: number, totalWords = 0): string | null {
  const words = sanitizeSpeech(transcript).split(' ').filter(Boolean);
  if (words.length === 0) return null;
  let selected = words.slice(-Math.max(1, Math.floor(count)));
  while (selected.length > 1 && selected.join(' ').length > MAX_QUOTE_CHARS - 2) selected = selected.slice(1);
  let body = selected.join(' ');
  if (body.length > MAX_QUOTE_CHARS - 2) body = body.slice(-(MAX_QUOTE_CHARS - 2));
  const truncated = selected.length < Math.max(words.length, totalWords) || body.length < selected.join(' ').length;
  return truncated ? `${ELLIPSIS} ${body}` : body;
}

export interface SearchMatch {
  readonly memoId: string;
  readonly title: string;
  readonly date: string;
  readonly excerpt: string;
}

/**
 * The matches of a search_transcripts result, sanitized; matches without an
 * excerpt are left out. null when the result isn't a search payload.
 */
export function parseMatches(result: { content: ReadonlyArray<{ type: string; text?: string }>; structuredContent?: unknown },
  timeZone?: string): SearchMatch[] | null {
  const payload = payloadOf(result);
  if (!payload || !Array.isArray(payload.matches)) return null;
  const matches: SearchMatch[] = [];
  for (const entry of payload.matches) {
    if (!isObject(entry)) continue;
    const excerpt = clip(sanitizeSpeech(entry.excerpt), MAX_QUOTE_CHARS);
    if (!excerpt) continue;
    matches.push({
      memoId: typeof entry.memo_id === 'string' ? entry.memo_id : '',
      title: clip(sanitizeSpeech(entry.title), MAX_TITLE_CHARS) || QUOTE_TEXT.untitled,
      date: quoteDate(entry.created_at, timeZone),
      excerpt,
    });
  }
  return matches;
}

/**
 * Quick pick labels render $(name) as an icon. Recorded speech and titles
 * shouldn't, so their "$(" gets a space.
 */
export const plainLabel = (text: string) => text.replace(/\$\(/g, '$ (');

export interface MatchItem extends vscode.QuickPickItem {
  readonly match: SearchMatch;
}

export function matchItems(matches: readonly SearchMatch[]): MatchItem[] {
  return matches.map((match) => ({
    label: plainLabel(match.title),
    description: match.date,
    detail: plainLabel(clip(match.excerpt, MAX_DETAIL_CHARS)),
    match,
  }));
}

// --- The command ------------------------------------------------------------

export type QuoteOutcome =
  | 'inserted-live' | 'inserted-search' | 'not-mac' | 'no-editor' | 'problem' | 'nothing-yet' | 'cancelled'
  | 'no-matches' | 'not-inserted' | 'editor-closed';

type QuoteWindow = Pick<typeof vscode.window, 'showInputBox' | 'showQuickPick' | 'showInformationMessage' |
  'showWarningMessage' | 'withProgress'> & { readonly activeTextEditor: vscode.TextEditor | undefined };

export interface QuoteDeps {
  readonly window: QuoteWindow;
  /** The sidecar's call. */
  call(tool: string, args: Record<string, unknown>, timeoutMs: number): Promise<SidecarAnswer>;
  getSettings(): { readonly port: number; readonly quoteWords: number; readonly quoteFormat: QuoteFormat };
  readonly platform: string;
  /** Shows what went wrong, with the extension's buttons (Set Token…, Open Setup Guide). */
  presentProblem(report: ConnectionReport): unknown;
  /** Every get_live_transcript answer, for the status bar item. */
  onLiveAnswer?(answer: SidecarAnswer): void;
  readonly progressLocation: vscode.ProgressLocation;
  readonly now?: () => Date;
  /** For tests; the editor's own time zone otherwise. */
  readonly timeZone?: string;
}

/** What went wrong with a call that didn't succeed, as Check Connection would say it. */
export function problemReport(answer: SidecarAnswer, port: number): ConnectionReport {
  const report = describeConnection(answer, { port, stored: null, allowClaudeSetup: false });
  return report.kind === 'ok' ? { kind: 'problem', text: QUOTE_TEXT.unreadable } : report;
}

async function insert(editor: vscode.TextEditor, quote: string, style: QuoteFormat): Promise<'inserted' | 'not-inserted' | 'editor-closed'> {
  if (editor.document.isClosed) return 'editor-closed';
  const applied = await editor.edit((builder) => {
    for (const selection of editor.selections) {
      builder.replace(selection, placeQuote(quote, style, selection.start.character === 0));
    }
  });
  return applied ? 'inserted' : 'not-inserted';
}

async function finish(deps: QuoteDeps, editor: vscode.TextEditor, quote: string, style: QuoteFormat,
  inserted: 'inserted-live' | 'inserted-search'): Promise<QuoteOutcome> {
  const result = await insert(editor, quote, style);
  if (result === 'inserted') return inserted;
  if (result === 'editor-closed') {
    void deps.window.showInformationMessage(QUOTE_TEXT.editorClosed);
    return 'editor-closed';
  }
  void deps.window.showWarningMessage(QUOTE_TEXT.notInserted);
  return 'not-inserted';
}

export async function insertQuote(deps: QuoteDeps): Promise<QuoteOutcome> {
  const { window } = deps;
  if (deps.platform !== 'darwin') {
    void window.showWarningMessage(notMac(deps.platform));
    return 'not-mac';
  }
  const editor = window.activeTextEditor;
  if (!editor) {
    void window.showInformationMessage(QUOTE_TEXT.noEditor);
    return 'no-editor';
  }
  const { port, quoteWords, quoteFormat } = deps.getSettings();

  // A recording in progress: its last words, read fresh.
  const live = await deps.call(LIVE_TOOL, { tail_words: quoteWords }, LIVE_TIMEOUT_MS);
  deps.onLiveAnswer?.(live);
  const liveResult = successfulResult(live);
  if (!liveResult) {
    await deps.presentProblem(problemReport(live, port));
    return 'problem';
  }
  const snapshot = parseLiveTranscript(liveResult);
  if (!snapshot) {
    await deps.presentProblem({ kind: 'problem', text: QUOTE_TEXT.unreadable });
    return 'problem';
  }
  if (snapshot.state === 'recording' || snapshot.state === 'paused') {
    const text = lastWords(snapshot.transcript, quoteWords, snapshot.wordCount);
    if (!text) {
      void window.showInformationMessage(QUOTE_TEXT.nothingYet);
      return 'nothing-yet';
    }
    const date = quoteDate((deps.now ?? (() => new Date()))(), deps.timeZone);
    const quote = formatQuote({ text, title: QUOTE_TEXT.liveTitle, date, style: quoteFormat });
    if (!quote) return 'nothing-yet';
    return finish(deps, editor, quote, quoteFormat, 'inserted-live');
  }

  // Otherwise: search the saved memos.
  const entered = await window.showInputBox({
    title: QUOTE_TEXT.title,
    prompt: QUOTE_TEXT.searchPrompt,
    placeHolder: QUOTE_TEXT.searchPlaceholder,
    ignoreFocusOut: true,
  });
  const query = typeof entered === 'string' ? entered.trim() : '';
  if (!query) return 'cancelled';
  const search = () => deps.call(SEARCH_TOOL, { query, limit: SEARCH_LIMIT }, SEARCH_TIMEOUT_MS);
  const found = await window.withProgress({ location: deps.progressLocation, title: QUOTE_TEXT.searching }, search);
  const foundResult = successfulResult(found);
  if (!foundResult) {
    await deps.presentProblem(problemReport(found, port));
    return 'problem';
  }
  const matches = parseMatches(foundResult, deps.timeZone);
  if (!matches) {
    await deps.presentProblem({ kind: 'problem', text: QUOTE_TEXT.unreadable });
    return 'problem';
  }
  if (matches.length === 0) {
    void window.showInformationMessage(QUOTE_TEXT.noMatches(clip(sanitizeSpeech(query), 80)));
    return 'no-matches';
  }
  const picked = await window.showQuickPick(matchItems(matches), {
    title: QUOTE_TEXT.title,
    placeHolder: QUOTE_TEXT.pickPlaceholder,
    matchOnDescription: true,
    matchOnDetail: true,
  });
  if (!picked) return 'cancelled';
  const quote = formatQuote({ text: picked.match.excerpt, title: picked.match.title, date: picked.match.date, style: quoteFormat });
  if (!quote) return 'cancelled';
  return finish(deps, editor, quote, quoteFormat, 'inserted-search');
}
