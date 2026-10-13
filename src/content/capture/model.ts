export type CaptureState = "receiving" | "complete" | "interrupted" | "failed";

export interface CaptureSnapshot {
  id: string;
  title: string;
  filenameBase: string;
  requestUrl: string;
  startedAt: number;
  lastChunkAt: number | null;
  completedAt: number | null;
  state: CaptureState;
  receivedBytes: number;
  contentLength: number | null;
  contentType: string;
  extension: string;
  formatVerified: boolean;
  formatError: string | null;
  mediaDurationSeconds: number | null;
  codecSignature: string | null;
  error: string | null;
}

export const SYNTHESIS_PATHS = ["/backend-api/synthesize"] as const;

export function requestUrl(input: RequestInfo | URL | { url?: string } | null | undefined): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.href;
  return typeof input?.url === "string" ? input.url : "";
}

export function isSynthesisRequest(input: RequestInfo | URL | { url?: string } | null | undefined): boolean {
  const url = requestUrl(input);
  if (!url) return false;

  try {
    const path = new URL(url, globalThis.location?.href).pathname;
    return SYNTHESIS_PATHS.some((candidate) => path === candidate || path.startsWith(`${candidate}/`));
  } catch (_) {
    return SYNTHESIS_PATHS.some((candidate) => new RegExp(`${candidate.replace(/[.*+?^${}()|[\\]\\]/g, "\\$&")}(?:[/?#]|$)`).test(url));
  }
}

export function contentLength(value: string | null | undefined): number | null {
  if (!value) return null;
  const bytes = Number(value);
  return Number.isSafeInteger(bytes) && bytes >= 0 ? bytes : null;
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  let size = bytes;
  let unit = 0;
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024;
    unit += 1;
  }
  const digits = unit === 0 ? 0 : size >= 100 ? 0 : 1;
  return `${size.toFixed(digits)} ${units[unit]}`;
}

export function captureProgress(capture: Pick<CaptureSnapshot, "receivedBytes" | "contentLength">): string {
  if (!capture.contentLength) return `${formatBytes(capture.receivedBytes)} received`;
  const percentage = Math.min(100, (capture.receivedBytes / capture.contentLength) * 100);
  return `${formatBytes(capture.receivedBytes)} / ${formatBytes(capture.contentLength)} • ${percentage.toFixed(1)}%`;
}

export function sanitizeFilenameBase(value: string): string {
  const cleaned = value
    .replace(/[<>:"/\\|?*\u0000-\u001F]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[. ]+$/g, "");
  return (cleaned || "chatgpt").slice(0, 120);
}

export function extensionFor(contentType: string, firstChunk?: Uint8Array): string {
  const type = contentType.toLowerCase().split(";", 1)[0].trim();
  if (type.includes("mpeg")) return "mp3";
  if (type.includes("aac")) return "aac";
  if (type.includes("mp4") || type.includes("m4a")) return "m4a";
  if (type.includes("wav")) return "wav";
  if (type.includes("ogg") || type.includes("opus")) return "ogg";
  if (type.includes("webm")) return "webm";

  if (firstChunk?.length) {
    if (firstChunk[0] === 0x49 && firstChunk[1] === 0x44 && firstChunk[2] === 0x33) return "mp3";
    if (firstChunk[0] === 0xff && (firstChunk[1] & 0xf6) === 0xf0) return "aac";
    if (String.fromCharCode(...firstChunk.slice(4, 8)) === "ftyp") return "m4a";
    if (String.fromCharCode(...firstChunk.slice(0, 4)) === "RIFF") return "wav";
    if (String.fromCharCode(...firstChunk.slice(0, 4)) === "OggS") return "ogg";
  }

  return "aac";
}

export function createCapture(input: {
  id: string;
  title: string;
  requestUrl: string;
  startedAt: number;
  contentType: string;
  contentLength: number | null;
}): CaptureSnapshot {
  return {
    ...input,
    title: sanitizeFilenameBase(input.title),
    filenameBase: sanitizeFilenameBase(input.title),
    lastChunkAt: null,
    completedAt: null,
    state: "receiving",
    receivedBytes: 0,
    extension: extensionFor(input.contentType),
    formatVerified: false,
    formatError: null,
    mediaDurationSeconds: null,
    codecSignature: null,
    error: null,
  };
}

export function addChunk(capture: CaptureSnapshot, chunk: Uint8Array, now: number): CaptureSnapshot {
  return {
    ...capture,
    receivedBytes: capture.receivedBytes + chunk.byteLength,
    lastChunkAt: now,
    extension: capture.receivedBytes === 0 ? extensionFor(capture.contentType, chunk) : capture.extension,
  };
}

export function completeCapture(capture: CaptureSnapshot, now: number): CaptureSnapshot {
  return { ...capture, state: "complete", completedAt: now, error: null };
}

export function interruptCapture(capture: CaptureSnapshot, error: unknown, now: number): CaptureSnapshot {
  const message = error instanceof Error ? error.message : String(error || "Capture interrupted");
  return { ...capture, state: "interrupted", completedAt: now, error: message };
}
