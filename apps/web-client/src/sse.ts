// sse.ts
//
// Minimal Server-Sent-Events frame parser for the ACP daemon's
// `/events` stream. The daemon's wire (see apps/acp-daemon/SPEC.md §7)
// emits frames shaped like:
//
//   id: <n>
//   data: <json>
//
//   id: <n+1>
//   data: <json>
//   ...
//
// Optional `event: <name>` lines mark `terminated` / `cursor_lost`
// out-of-band events; the parser surfaces them so the client can stop
// the stream gracefully.
//
// We intentionally do NOT use the browser's built-in EventSource —
// EventSource cannot send a custom Authorization header, which the
// daemon requires (SPEC.md §3). Instead the client uses fetch + a
// ReadableStream reader and feeds chunks into this parser.

export type SseFrame = {
  /** Monotonic per-session sequence id (SPEC.md §8). undefined on comment / event-only frames. */
  readonly id?: number;
  /** SSE `event:` field; for ACP this is `terminated` / `cursor_lost` / undefined. */
  readonly event?: string;
  /** SSE `data:` payload; for ACP `data` frames this is the JSON-RPC message string. */
  readonly data: string;
};

/**
 * Stateful parser: feed bytes / strings via `push`, drain completed
 * frames via `take`. Splits on the blank-line delimiter required by
 * the SSE wire (`\n\n`).
 */
export class SseFrameParser {
  private buffer = "";
  private readonly pending: SseFrame[] = [];

  push(chunk: string): void {
    this.buffer += chunk;
    let blank: number;
    while ((blank = this.buffer.indexOf("\n\n")) !== -1) {
      const raw = this.buffer.slice(0, blank);
      this.buffer = this.buffer.slice(blank + 2);
      if (!raw || raw.startsWith(": ")) continue; // empty or keepalive comment
      const frame = parseFrame(raw);
      if (frame) this.pending.push(frame);
    }
  }

  /** Returns all completed frames since the last call. */
  take(): SseFrame[] {
    if (this.pending.length === 0) return [];
    const out = this.pending.slice();
    this.pending.length = 0;
    return out;
  }
}

function parseFrame(raw: string): SseFrame | null {
  let id: number | undefined;
  let event: string | undefined;
  const dataLines: string[] = [];
  for (const line of raw.split("\n")) {
    if (line.startsWith("id:")) {
      const parsed = Number.parseInt(line.slice(3).trim(), 10);
      if (Number.isFinite(parsed) && parsed >= 0) id = parsed;
    } else if (line.startsWith("event:")) {
      event = line.slice(6).trim();
    } else if (line.startsWith("data:")) {
      dataLines.push(line.slice(5).trim());
    }
  }
  if (id === undefined && event === undefined && dataLines.length === 0) return null;
  return { id, event, data: dataLines.join("\n") };
}
