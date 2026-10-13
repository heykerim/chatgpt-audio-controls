export interface CaptureDiagnosticEvent {
  at: number;
  type: string;
  data: Record<string, unknown>;
}

/**
 * Keeps the runtime evidence needed to understand a Read Aloud session. The
 * trace intentionally contains media metadata only, never response text or
 * audio payloads.
 */
export class CaptureDiagnostics {
  private readonly events: CaptureDiagnosticEvent[] = [];

  constructor(private readonly maxEvents = 12_000, private readonly now: () => number = Date.now) {}

  record(type: string, data: Record<string, unknown> = {}): void {
    this.events.push({ at: this.now(), type, data });
    if (this.events.length > this.maxEvents) this.events.splice(0, this.events.length - this.maxEvents);
  }

  snapshot(): CaptureDiagnosticEvent[] {
    return this.events.map((event) => ({ ...event, data: { ...event.data } }));
  }

  clear(): void {
    this.events.length = 0;
  }
}
