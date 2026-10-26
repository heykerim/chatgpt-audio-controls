export const BATCH_CHUNK_CHARACTER_LIMIT = 20_000;

export interface ReadAloudBatchPlan {
  id: string;
  title: string;
  sourceText: string;
  chunks: string[];
  nextChunkIndex: number;
  sessionIds: string[];
  state: "branching" | "generating" | "capturing" | "joining" | "complete" | "failed";
  createdAt: number;
  error: string | null;
}

export function normalizeBatchText(value: string): string {
  return value.replace(/\r\n?/g, "\n").replace(/[ \t]+\n/g, "\n").trim();
}

export function batchTextsMatch(expected: string, actual: string): boolean {
  return normalizeBatchText(expected) === normalizeBatchText(actual);
}

export function splitReadAloudText(text: string, limit = BATCH_CHUNK_CHARACTER_LIMIT): string[] {
  const source = normalizeBatchText(text);
  if (!source) return [];
  if (!Number.isSafeInteger(limit) || limit < 1_000) throw new Error("The Read Aloud batch limit must be at least 1,000 characters.");

  const chunks: string[] = [];
  let remaining = source;
  while (remaining.length > limit) {
    const candidate = remaining.slice(0, limit + 1);
    const minimumBreak = Math.floor(limit * 0.6);
    const breakPoints = [
      candidate.lastIndexOf("\n\n", limit),
      candidate.lastIndexOf(". ", limit),
      candidate.lastIndexOf("! ", limit),
      candidate.lastIndexOf("? ", limit),
      candidate.lastIndexOf("\n", limit),
      candidate.lastIndexOf(" ", limit),
    ].filter((index) => index >= minimumBreak);
    const splitAt = breakPoints.length ? Math.max(...breakPoints) + 1 : limit;
    chunks.push(remaining.slice(0, splitAt).trim());
    remaining = remaining.slice(splitAt).trim();
  }
  if (remaining) chunks.push(remaining);
  return chunks;
}

export function batchPrompt(chunk: string, index: number, total: number): string {
  return [
    `Return only the exact text inside <read-aloud-part> below. This is part ${index + 1} of ${total}.`,
    "Do not add an introduction, conclusion, code fence, quotation marks, or commentary.",
    "Preserve every word and paragraph exactly.",
    "",
    "<read-aloud-part>",
    chunk,
    "</read-aloud-part>",
  ].join("\n");
}
