export interface ChunkStore {
  put(captureId: string, index: number, chunk: Uint8Array): Promise<void>;
  getAll(captureId: string): Promise<Uint8Array[]>;
  clear(captureId: string): Promise<void>;
}

const DB_NAME = "cgpt-read-aloud-captures";
const STORE_NAME = "chunks";

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => {
      const store = request.result.createObjectStore(STORE_NAME, { keyPath: ["captureId", "index"] });
      store.createIndex("byCapture", "captureId", { unique: false });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error("Could not open capture storage."));
  });
}

export class IndexedChunkStore implements ChunkStore {
  private database: Promise<IDBDatabase> | null = null;

  private get db(): Promise<IDBDatabase> {
    this.database ||= openDatabase();
    return this.database;
  }

  async put(captureId: string, index: number, chunk: Uint8Array): Promise<void> {
    const db = await this.db;
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, "readwrite");
      tx.objectStore(STORE_NAME).put({ captureId, index, chunk: chunk.buffer.slice(chunk.byteOffset, chunk.byteOffset + chunk.byteLength) });
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error || new Error("Could not save an audio chunk."));
      tx.onabort = () => reject(tx.error || new Error("Audio chunk storage was aborted."));
    });
  }

  async getAll(captureId: string): Promise<Uint8Array[]> {
    const db = await this.db;
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, "readonly");
      const request = tx.objectStore(STORE_NAME).index("byCapture").getAll(IDBKeyRange.only(captureId));
      request.onsuccess = () => {
        const rows = (request.result as Array<{ index: number; chunk: ArrayBuffer }>).sort((a, b) => a.index - b.index);
        resolve(rows.map((row) => new Uint8Array(row.chunk)));
      };
      request.onerror = () => reject(request.error || new Error("Could not read audio chunks."));
    });
  }

  async clear(captureId: string): Promise<void> {
    const db = await this.db;
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, "readwrite");
      const request = tx.objectStore(STORE_NAME).index("byCapture").openKeyCursor(IDBKeyRange.only(captureId));
      request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor) return;
        cursor.delete();
        cursor.continue();
      };
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error || new Error("Could not remove audio chunks."));
    });
  }
}
