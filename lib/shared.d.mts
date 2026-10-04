// Type declarations for shared.mjs, so the mod (hooks/register.tsx) and its
// tests type-check under the tsconfig Claude Code writes beside a mod, which
// does not read JavaScript sources. Keep in step with shared.mjs.

export declare const WISPLY_ENDPOINT: 'http://127.0.0.1:51771/mcp';
export declare const WISPLY_IDENTITY_ENDPOINT: 'http://127.0.0.1:51771/mcp/identity';
export declare const BRIDGE_NAME: string;
export declare const BRIDGE_VERSION: string;
export declare const PROTOCOL_VERSIONS: readonly string[];
export declare const MAX_RESPONSE_BYTES: number;
export declare const READ_ONLY_TOOLS: readonly ['list_memos', 'search_transcripts', 'get_live_transcript', 'get_action_items'];

export type ToolDescriptor = {
  readonly name: string;
  readonly title: string;
  readonly description: string;
  readonly inputSchema: Readonly<Record<string, unknown>>;
  readonly annotations: Readonly<Record<string, unknown>>;
};
export declare const TOOL_DESCRIPTORS: readonly ToolDescriptor[];

export declare const BRIDGE_INSTRUCTIONS: string;
export declare const SETUP_MARKER: string;
export declare const SETUP_MESSAGE: string;
export declare const REQUEST_FAILED_MESSAGE: string;
export declare const UNAVAILABLE_MESSAGE: string;
export declare const IDENTITY_MARKER: string;
export declare const NOT_WISPLY_MESSAGE: string;
export declare const UPDATE_WISPLY_MESSAGE: string;
export declare const SCOPE_MESSAGE: string;

export declare function tokenProblem(raw: unknown): 'missing' | 'placeholder' | 'malformed' | null;
export declare function usableToken(raw: unknown): string | null;
export declare function requestTimeoutMs(
  message: { method?: unknown; params?: { name?: unknown } } | null | undefined,
): number;

export type LiveSnapshot = {
  state: 'recording' | 'paused' | 'idle' | 'unknown';
  durationSeconds: number;
  wordCount: number;
  speakerCount: number;
  transcript: string;
};
export declare function parseLiveTranscript(result: unknown): LiveSnapshot | null;
export declare function classifyFailure(failure: unknown): 'setup' | 'unverified' | 'offline';

export type StatusLike = { phase: string; durationSeconds?: number; wordCount?: number };
export declare function formatDuration(seconds: number): string;
export declare function formatStatusLine(status: StatusLike | null | undefined): string | undefined;
export declare function formatBandLabel(status: StatusLike | null | undefined): string | undefined;
export declare function describeStatus(status: StatusLike | null | undefined): string;

export declare function sanitizeSpeech(text: unknown): string;

export declare const DEFAULT_QUOTE_WORDS: number;
export declare const MIN_QUOTE_WORDS: number;
export declare const MAX_QUOTE_WORDS: number;
export declare function clampQuoteWords(value: unknown, fallback?: number): number;

export type Excerpt = { text: string; words: number; totalWords: number; isTruncated: boolean };
export declare function buildExcerpt(
  transcript: unknown,
  options?: { maxWords?: number; durationSeconds?: number },
): Excerpt | null;

export declare const MAX_POLL_FAILURES: number;
export declare function nextPollDelayMs(phase: string, consecutiveFailures?: number): number | null;
