import { describe, expect, test } from "bun:test";
import { addChunk, captureProgress, contentLength, createCapture, extensionFor, isSynthesisRequest, requestUrl, sanitizeFilenameBase } from "./model";
import { CaptureDiagnostics } from "./diagnostics";
import { ReadAloudSessionManager } from "./session-manager";
import { inspectAdts } from "./adts";
import type { ChunkStore } from "./indexed-chunk-store";

class MemoryChunkStore implements ChunkStore {
  readonly chunks = new Map<string, Uint8Array[]>();
  async put(id: string, index: number, chunk: Uint8Array): Promise<void> {
    const entries = this.chunks.get(id) || [];
    entries[index] = chunk;
    this.chunks.set(id, entries);
  }
  async getAll(id: string): Promise<Uint8Array[]> { return this.chunks.get(id) || []; }
  async clear(id: string): Promise<void> { this.chunks.delete(id); }
}

function streamedResponse(chunks: Uint8Array[], headers: HeadersInit = { "content-type": "audio/aac" }): Response {
  return new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      chunks.forEach((chunk) => controller.enqueue(chunk));
      controller.close();
    },
  }), { headers });
}

function adtsFrame(payloadByte: number, sampleRateIndex = 4, channelCount = 2): Uint8Array {
  const payloadLength = 5;
  const frameLength = 7 + payloadLength;
  return new Uint8Array([
    0xff,
    0xf1,
    (1 << 6) | (sampleRateIndex << 2) | (channelCount >> 2),
    ((channelCount & 3) << 6) | ((frameLength >> 11) & 3),
    (frameLength >> 3) & 0xff,
    ((frameLength & 7) << 5) | 0x1f,
    0xfc,
    payloadByte,
    payloadByte,
    payloadByte,
    payloadByte,
    payloadByte,
  ]);
}

function splitBytes(bytes: Uint8Array, offsets: number[]): Uint8Array[] {
  const chunks: Uint8Array[] = [];
  let start = 0;
  for (const end of offsets) {
    chunks.push(bytes.slice(start, end));
    start = end;
  }
  chunks.push(bytes.slice(start));
  return chunks.filter((chunk) => chunk.length > 0);
}

describe("Read Aloud capture model", () => {
  test("recognizes only the current synthesize endpoint", () => {
    expect(isSynthesisRequest("https://chatgpt.com/backend-api/synthesize?x=1")).toBe(true);
    expect(isSynthesisRequest("https://chatgpt.com/backend-api/conversation")).toBe(false);
  });

  test("does not capture lookalike audio URLs", () => {
    expect(isSynthesisRequest("https://chatgpt.com/backend-api/synthesize-other")).toBe(false);
    expect(isSynthesisRequest("https://chatgpt.com/backend-api/voice")).toBe(false);
  });

  test("extracts Request-object URLs", () => {
    const request = new Request("https://chatgpt.com/backend-api/synthesize");
    expect(requestUrl(request)).toBe(request.url);
  });

  test("parses valid Content-Length values and rejects unsafe values", () => {
    expect(contentLength("123")).toBe(123);
    expect(contentLength("-1")).toBeNull();
    expect(contentLength("not-a-number")).toBeNull();
    expect(contentLength(String(Number.MAX_SAFE_INTEGER + 1))).toBeNull();
  });

  test("accumulates progressive bytes and reports known lengths honestly", () => {
    const created = createCapture({ id: "a", title: "One", requestUrl: "x", startedAt: 1, contentType: "audio/aac", contentLength: 100 });
    const next = addChunk(created, new Uint8Array(40), 2);
    expect(next.receivedBytes).toBe(40);
    expect(captureProgress(next)).toContain("40.0%");
  });

  test("does not invent a percentage without Content-Length", () => {
    expect(captureProgress({ receivedBytes: 40 * 1024 * 1024, contentLength: null })).toBe("40.0 MB received");
  });

  test("sanitizes filenames and maps MIME or magic bytes", () => {
    expect(sanitizeFilenameBase('A:/ bad* title. ')).toBe("A bad title");
    expect(extensionFor("audio/aac")).toBe("aac");
    expect(extensionFor("application/octet-stream", new Uint8Array([0xff, 0xf1]))).toBe("aac");
    expect(extensionFor("", new Uint8Array([0, 0, 0, 0, 0x66, 0x74, 0x79, 0x70]))).toBe("m4a");
    expect(extensionFor("audio/mp4")).toBe("m4a");
    expect(extensionFor("application/octet-stream", new Uint8Array([0x49, 0x44, 0x33]))).toBe("mp3");
  });

  test("moves a captured part from receiving to complete without confusing it with playback", async () => {
    const manager = new ReadAloudSessionManager(new MemoryChunkStore(), () => 10);
    manager.begin("Long response");
    const response = streamedResponse([new Uint8Array([0xff, 0xf1, 1]), new Uint8Array([2, 3])]);
    const part = manager.beginPart({ title: "Long response", requestUrl: "https://chatgpt.com/backend-api/synthesize", response });
    await manager.captureResponse(part.id, response.clone(), () => {});
    const [session] = manager.summaries();
    expect(session.state).toBe("waiting");
    expect(session.parts[0].receivedBytes).toBe(5);
    expect(session.parts[0].state).toBe("complete");
  });

  test("does not expose a download until the current runtime completion signal is applied", async () => {
    const manager = new ReadAloudSessionManager(new MemoryChunkStore(), () => 10);
    manager.begin("Long response");
    const response = streamedResponse([new Uint8Array([0xff, 0xf1, 1])]);
    const part = manager.beginPart({ title: "Long response", requestUrl: "https://chatgpt.com/backend-api/synthesize", response });
    await manager.captureResponse(part.id, response.clone(), () => {});
    expect(manager.summaries()[0].state).toBe("waiting");
    await expect(manager.blobForSession(manager.summaries()[0].id)).rejects.toThrow("complete Read Aloud session");
    manager.completeCurrentSession();
    expect(manager.summaries()[0].state).toBe("complete");
  });

  test("marks stream errors as interrupted and never complete", async () => {
    const manager = new ReadAloudSessionManager(new MemoryChunkStore(), () => 10);
    manager.begin("Interrupted");
    const response = new Response(new ReadableStream<Uint8Array>({
      start(controller) { controller.error(new Error("network stopped")); },
    }), { headers: { "content-type": "audio/aac" } });
    const part = manager.beginPart({ title: "Interrupted", requestUrl: "https://chatgpt.com/backend-api/synthesize", response });
    await manager.captureResponse(part.id, response.clone(), () => {});
    expect(manager.summaries()[0].state).toBe("interrupted");
  });

  test("keeps sequential synthesize responses as separate parts in one session", async () => {
    const manager = new ReadAloudSessionManager(new MemoryChunkStore(), () => 10);
    manager.begin("Two parts");
    const first = new Uint8Array([...adtsFrame(1), ...adtsFrame(2)]);
    const second = new Uint8Array([...adtsFrame(3), ...adtsFrame(4), ...adtsFrame(5)]);
    for (const chunks of [splitBytes(first, [3, 17]), splitBytes(second, [1, 8, 25])]) {
      const response = streamedResponse(chunks);
      const part = manager.beginPart({ title: "Two parts", requestUrl: "https://chatgpt.com/backend-api/synthesize", response });
      await manager.captureResponse(part.id, response.clone(), () => {});
    }
    manager.completeCurrentSession();
    const session = manager.summaries()[0];
    expect(session.parts).toHaveLength(2);
    expect(session.state).toBe("complete");
    expect(session.canDownload).toBe(true);
    expect(session.durationSeconds).toBeCloseTo((5 * 1024) / 44100, 8);
    expect((await manager.blobForSession(session.id)).size).toBe(first.length + second.length);
  });

  test("validates every ADTS frame across arbitrary network chunk boundaries", () => {
    const audio = new Uint8Array([...adtsFrame(1), ...adtsFrame(2), ...adtsFrame(3)]);
    const inspected = inspectAdts(splitBytes(audio, [1, 6, 9, 19, 31]));
    expect(inspected.valid).toBe(true);
    expect(inspected.frameCount).toBe(3);
    expect(inspected.sampleRate).toBe(44100);
    expect(inspected.channelCount).toBe(2);
    expect(inspected.durationSeconds).toBeCloseTo((3 * 1024) / 44100, 8);
  });

  test("rejects truncated or incompatible ADTS responses", () => {
    const valid = adtsFrame(1);
    expect(inspectAdts([valid.slice(0, valid.length - 1)]).valid).toBe(false);
    expect(inspectAdts([new Uint8Array([...adtsFrame(1), ...adtsFrame(2, 3)])]).valid).toBe(false);
  });

  test("rejects unproven multi-container joining", async () => {
    const manager = new ReadAloudSessionManager(new MemoryChunkStore(), () => 10);
    manager.begin("Container parts");
    for (const chunk of [new Uint8Array([0, 0, 0, 0, 0x66, 0x74, 0x79, 0x70]), new Uint8Array([0, 0, 0, 0, 0x66, 0x74, 0x79, 0x70])]) {
      const response = streamedResponse([chunk], { "content-type": "audio/mp4" });
      const part = manager.beginPart({ title: "Container parts", requestUrl: "https://chatgpt.com/backend-api/synthesize", response });
      await manager.captureResponse(part.id, response.clone(), () => {});
    }
    manager.completeCurrentSession();
    await expect(manager.blobForSession(manager.summaries()[0].id)).rejects.toThrow("need remuxing");
  });

  test("bounds diagnostic metadata without retaining audio", () => {
    const diagnostics = new CaptureDiagnostics(2, () => 10);
    diagnostics.record("one", { bytes: 1 });
    diagnostics.record("two", { bytes: 2 });
    diagnostics.record("three", { bytes: 3 });
    expect(diagnostics.snapshot()).toEqual([
      { at: 10, type: "two", data: { bytes: 2 } },
      { at: 10, type: "three", data: { bytes: 3 } },
    ]);
  });
});
