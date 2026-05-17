// Pure aggregating barrel; do NOT add implementation here so that
// session-index.ts (and other leaf modules) can import their dependencies
// from leaf files without producing a circular evaluation order.

export {
  EventLogDecodeError,
  EventLogSequenceError,
  JsonlEventLog,
  appendEvent,
  appendEvents,
  decodeEvent,
  encodeEvent,
  readEventLog,
  validateEventOrder,
  type EventLogRecoveryMode,
  type ReadEventLogOptions,
} from "./event-log";

export {
  SessionIndex,
  type SessionClient,
  type SessionIndexRow,
  type TurnIndexRow,
} from "./session-index";
