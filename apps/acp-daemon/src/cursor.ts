import { EventEmitter } from "node:events";

// Per-session monotonic event sequence + bounded ring buffer.
//
// SPEC.md §8: the daemon retains the last N events per session. Clients
// reconnecting to /events send `Last-Event-ID: <n>` and get every event
// with sequence > n replayed before the live stream resumes.
//
// We separate "buffer" from "live stream" with an EventEmitter so multiple
// subscribers can fan out; in practice only one SSE client per session is
// expected, but the design tolerates a debug client tapping in parallel.

export const DEFAULT_RING_SIZE = 256;

export type CursorEvent = {
  /** Monotonic sequence number, starts at 1. */
  id: number;
  /** Raw JSON payload to send as SSE `data:`. */
  data: string;
};

export class SessionCursor extends EventEmitter {
  private readonly ring: CursorEvent[] = [];
  private readonly capacity: number;
  private seq = 0;
  private closed = false;

  constructor(capacity: number = DEFAULT_RING_SIZE) {
    super();
    this.capacity = Math.max(1, capacity);
    // We expect at most a handful of listeners (one SSE consumer plus
    // tests). The default maxListeners of 10 is fine, but bump to silence
    // warnings when many tests share a singleton manager.
    this.setMaxListeners(50);
  }

  /** Append an event, returning the assigned sequence id. */
  push(data: string): number {
    if (this.closed) {
      throw new Error("cursor is closed");
    }
    this.seq += 1;
    const event: CursorEvent = { id: this.seq, data };
    this.ring.push(event);
    if (this.ring.length > this.capacity) {
      this.ring.shift();
    }
    this.emit("event", event);
    return event.id;
  }

  /** Latest assigned sequence number (0 if none assigned yet). */
  get latest(): number {
    return this.seq;
  }

  /** Oldest sequence still in the ring (0 if empty). */
  get oldest(): number {
    return this.ring[0]?.id ?? 0;
  }

  /** Replay events with id > `fromCursor`. */
  replay(fromCursor: number): CursorEvent[] {
    if (fromCursor >= this.seq) return [];
    return this.ring.filter((e) => e.id > fromCursor);
  }

  /**
   * Whether a Last-Event-ID is recoverable. False means the client is too
   * far behind and must restart (see SPEC.md §8 cursor_lost).
   */
  canResumeFrom(fromCursor: number): boolean {
    // The cursor is recoverable if the next event we'd replay still
    // exists in the ring. If `fromCursor` is 0 (fresh connect), or
    // already at `seq`, we trivially "can resume" (nothing to replay).
    if (fromCursor >= this.seq) return true;
    if (this.ring.length === 0) return true;
    return fromCursor >= this.ring[0].id - 1;
  }

  /** Close the cursor; further push() will throw and listeners are removed. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.emit("close");
    this.removeAllListeners();
  }

  get isClosed(): boolean {
    return this.closed;
  }
}
