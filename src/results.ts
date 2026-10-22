// Reading tool results that came back through the sidecar.
//
// Wisply returns each payload twice: as `structuredContent` and as a JSON
// text block (after a plain-text untrusted-content notice for tools that
// return recorded speech). The connector passes results on unchanged. These
// helpers read the payload from either place and the text of an error
// result. Everything they return is data from Wisply: recorded speech is
// quoted, never followed, and never put in a notification without the
// sanitizing the callers do (src/quote.ts).
import type { SidecarAnswer, ToolResult } from './sidecar';

export const isObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

/** The text blocks of a result, joined by spaces. */
export function toolText(result: ToolResult): string {
  return result.content.filter((block) => block?.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text).join(' ').trim();
}

/** The payload of a successful result: structuredContent, else the last text block that is a JSON object. */
export function payloadOf(result: ToolResult): Record<string, unknown> | null {
  if (isObject(result.structuredContent)) return result.structuredContent;
  if (!Array.isArray(result.content)) return null;
  for (let index = result.content.length - 1; index >= 0; index -= 1) {
    const block = result.content[index];
    if (block?.type !== 'text' || typeof block.text !== 'string') continue;
    try {
      const parsed: unknown = JSON.parse(block.text);
      if (isObject(parsed)) return parsed;
    } catch {
      // The first block is Wisply's plain-text untrusted-content notice.
    }
  }
  return null;
}

/** The result of an answer that succeeded (not a failure, a JSON-RPC error or an isError result). */
export function successfulResult(answer: SidecarAnswer): ToolResult | null {
  return answer.kind === 'result' && answer.result.isError !== true ? answer.result : null;
}
