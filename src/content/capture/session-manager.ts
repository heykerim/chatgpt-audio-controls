import {
  addChunk,
  completeCapture,
  contentLength,
  createCapture,
  interruptCapture,
  type CaptureSnapshot,
} from "./model";
import type { ChunkStore } from "./indexed-chunk-store";
import { inspectAdts } from "./adts";

export type SessionState = "receiving" | "waiting" | "complete" | "partial" | "interrupted";

export const OBSERVED_SYNTHESIS_TEXT_LIMIT = 50_000;

export interface ReadAloudSession {
  id: string;
  title: string;
  startedAt: number;
  finishedAt: number | null;
  state: SessionState;
  sourceCharacterCount: number | null;
  parts: CaptureSnapshot[];
}

export interface SessionSummary {
  id: string;
  title: string;
  state: SessionState;
  partCount: number;
  receivedBytes: number;
  startedAt: number;
  finishedAt: number | null;
  canDownload: boolean;
  durationSeconds: number | null;
  sourceCharacterCount: number | null;
  sourceLimitExceeded: boolean;
  parts: CaptureSnapshot[];
}

export class ReadAloudSessionManager {
  private readonly sessions = new Map<string, ReadAloudSession>();
  private currentSessionId: string | null = null;
  private readonly partToSession = new Map<string, string>();

  constructor(private readonly store: ChunkStore, private readonly now: () => number = Date.now) {}

  begin(title: string, sourceCharacterCount: number | null = null): ReadAloudSession {
    const session: ReadAloudSession = {
      id: `session-${this.now()}-${crypto.getRandomValues(new Uint32Array(1))[0].toString(36)}`,
      title,
      startedAt: this.now(),
      finishedAt: null,
      state: "receiving",
      sourceCharacterCount,
      parts: [],
    };
    this.sessions.set(session.id, session);
    this.currentSessionId = session.id;
    return session;
  }

  beginPart(input: { title: string; requestUrl: string; response: Response }): CaptureSnapshot {
    let session = this.currentSessionId ? this.sessions.get(this.currentSessionId) : undefined;
    if (!session || session.state === "complete" || session.state === "partial" || session.state === "interrupted") {
      session = this.begin(input.title);
    }

    const part = createCapture({
      id: `part-${this.now()}-${crypto.getRandomValues(new Uint32Array(1))[0].toString(36)}`,
      title: input.title,
      requestUrl: input.requestUrl,
      startedAt: this.now(),
      contentType: input.response.headers.get("content-type") || "",
      contentLength: contentLength(input.response.headers.get("content-length")),
    });
    session.parts.push(part);
    session.state = "receiving";
    this.partToSession.set(part.id, session.id);
    return part;
  }

  async captureResponse(partId: string, response: Response, onChange: () => void): Promise<void> {
    const session = this.sessionForPart(partId);
    const part = session?.parts.find((candidate) => candidate.id === partId);
    if (!session || !part) return;
    if (!response.body) {
      this.replacePart(session, interruptCapture(part, new Error("Response body is unavailable."), this.now()));
      session.state = "interrupted";
      onChange();
      return;
    }

    const reader = response.body.getReader();
    let index = 0;
    try {
      while (true) {
        const result = await reader.read();
        if (result.done) break;
        if (!result.value?.byteLength) continue;
        await this.store.put(partId, index, result.value);
        index += 1;
        const latest = this.partFor(session, partId);
        this.replacePart(session, addChunk(latest, result.value, this.now()));
        onChange();
      }
      const latest = this.partFor(session, partId);
      const inspection = inspectAdts(await this.store.getAll(partId));
      this.replacePart(session, {
        ...completeCapture(latest, this.now()),
        formatVerified: inspection.valid,
        formatError: inspection.error,
        mediaDurationSeconds: inspection.durationSeconds,
        codecSignature: inspection.signature,
      });
      session.state = "waiting";
      onChange();
    } catch (error) {
      const latest = this.partFor(session, partId);
      this.replacePart(session, interruptCapture(latest, error, this.now()));
      session.state = "interrupted";
      onChange();
    } finally {
      reader.releaseLock();
    }
  }

  markPlaybackEnded(): void {
    const session = this.currentSession();
    if (session && session.state === "waiting") session.state = "waiting";
  }

  completeCurrentSession(): void {
    const session = this.currentSession();
    if (!session || session.state === "receiving" || session.parts.some((part) => part.state !== "complete")) return;
    session.state = session.sourceCharacterCount !== null && session.sourceCharacterCount > OBSERVED_SYNTHESIS_TEXT_LIMIT
      ? "partial"
      : "complete";
    session.finishedAt = this.now();
    this.currentSessionId = null;
  }

  interruptCurrentSession(reason: string): void {
    const session = this.currentSession();
    if (!session) return;
    session.state = "interrupted";
    session.finishedAt = this.now();
    session.parts = session.parts.map((part) =>
      part.state === "receiving" ? interruptCapture(part, new Error(reason), this.now()) : part,
    );
  }

  currentSession(): ReadAloudSession | undefined {
    return this.currentSessionId ? this.sessions.get(this.currentSessionId) : undefined;
  }

  summaries(): SessionSummary[] {
    return [...this.sessions.values()]
      .sort((a, b) => b.startedAt - a.startedAt)
      .map((session) => {
        const compatibility = compatibleParts(session.parts);
        return {
          id: session.id,
          title: session.title,
          state: session.state,
          partCount: session.parts.length,
          receivedBytes: session.parts.reduce((total, part) => total + part.receivedBytes, 0),
          startedAt: session.startedAt,
          finishedAt: session.finishedAt,
          canDownload:
            (session.state === "complete" || session.state === "partial") &&
            (session.parts.length === 1 ? session.parts[0].receivedBytes > 0 : compatibility.compatible),
          durationSeconds: compatibility.durationSeconds,
          sourceCharacterCount: session.sourceCharacterCount,
          sourceLimitExceeded:
            session.sourceCharacterCount !== null && session.sourceCharacterCount > OBSERVED_SYNTHESIS_TEXT_LIMIT,
          parts: session.parts.map((part) => ({ ...part })),
        };
      });
  }

  async blobForSession(sessionId: string): Promise<Blob> {
    const session = this.sessions.get(sessionId);
    if (!session || (session.state !== "complete" && session.state !== "partial") || !session.parts.length) {
      throw new Error("A downloadable Read Aloud capture is not available.");
    }
    const partChunks = await Promise.all(session.parts.map((part) => this.store.getAll(part.id)));
    if (session.parts.length > 1) {
      const inspections = partChunks.map(inspectAdts);
      const signatures = new Set(inspections.map((inspection) => inspection.signature));
      if (inspections.some((inspection) => !inspection.valid) || signatures.size !== 1) {
        throw new Error("This session has incompatible or containerized parts. They need remuxing before one complete download is safe.");
      }
    }
    const blobParts = partChunks.flat().map((chunk) =>
      chunk.buffer.slice(chunk.byteOffset, chunk.byteOffset + chunk.byteLength) as ArrayBuffer,
    );
    return new Blob(blobParts, { type: session.parts[0].contentType || "audio/aac" });
  }

  async blobForSessions(sessionIds: string[]): Promise<Blob> {
    const sessions = sessionIds.map((id) => this.sessions.get(id));
    if (!sessions.length || sessions.some((session) => !session || (session.state !== "complete" && session.state !== "partial"))) {
      throw new Error("Every Read Aloud batch part must be captured before joining.");
    }

    const captures = sessions.flatMap((session) => session?.parts || []);
    const partChunks = await Promise.all(captures.map((part) => this.store.getAll(part.id)));
    const inspections = partChunks.map(inspectAdts);
    const signatures = new Set(inspections.map((inspection) => inspection.signature));
    if (inspections.some((inspection) => !inspection.valid) || signatures.size !== 1) {
      throw new Error("The batch audio parts are not compatible AAC/ADTS streams.");
    }

    const blobParts = partChunks.flat().map((chunk) =>
      chunk.buffer.slice(chunk.byteOffset, chunk.byteOffset + chunk.byteLength) as ArrayBuffer,
    );
    return new Blob(blobParts, { type: captures[0]?.contentType || "audio/aac" });
  }

  private sessionForPart(partId: string): ReadAloudSession | undefined {
    const sessionId = this.partToSession.get(partId);
    return sessionId ? this.sessions.get(sessionId) : undefined;
  }

  private partFor(session: ReadAloudSession, partId: string): CaptureSnapshot {
    const part = session.parts.find((candidate) => candidate.id === partId);
    if (!part) throw new Error("Capture part no longer exists.");
    return part;
  }

  private replacePart(session: ReadAloudSession, next: CaptureSnapshot): void {
    const index = session.parts.findIndex((part) => part.id === next.id);
    if (index >= 0) session.parts[index] = next;
  }
}

function compatibleParts(parts: CaptureSnapshot[]): { compatible: boolean; durationSeconds: number | null } {
  if (!parts.length || parts.some((part) => !part.formatVerified || !part.codecSignature || part.mediaDurationSeconds === null)) {
    return { compatible: false, durationSeconds: null };
  }
  const signatures = new Set(parts.map((part) => part.codecSignature));
  if (signatures.size !== 1) return { compatible: false, durationSeconds: null };
  return {
    compatible: true,
    durationSeconds: parts.reduce((total, part) => total + (part.mediaDurationSeconds || 0), 0),
  };
}
