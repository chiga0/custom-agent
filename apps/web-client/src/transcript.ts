import type { SessionUpdate } from "@custom-agent/schema/acp";

// transcript.ts
//
// Pure reducer over the ACP SessionUpdate variants the daemon forwards.
// Stays a leaf module so DOM rendering and SSE plumbing can be tested
// independently of the network. Mirrors the events emitted by the
// existing `apps/acp-server/src/event-mapper.ts`:
//
//   - user_message_chunk  → append to a 'user' turn
//   - agent_message_chunk → append to an 'agent' turn (concatenate per turn)
//
// Future SessionUpdate variants (tool_call / plan / etc.) are no-ops
// here for forward-compat with M3+ tool events; the M1 transcript only
// needs to render the M1 wire surface.

export type TranscriptRole = "user" | "agent";

export type TranscriptTurn = {
  /** Stable identifier for this turn within the transcript, monotonic from 1. */
  readonly id: number;
  readonly role: TranscriptRole;
  /** Accumulated text (post-chunking) shown to the user. */
  text: string;
};

export type TranscriptState = {
  readonly turns: readonly TranscriptTurn[];
  /** Monotonic counter to mint turn ids without depending on event id. */
  readonly nextId: number;
};

export const EMPTY_TRANSCRIPT: TranscriptState = Object.freeze({
  turns: Object.freeze([]),
  nextId: 1,
});

/**
 * Apply one ACP SessionUpdate to the transcript state. Returns a NEW
 * TranscriptState reference whenever the update is recognized, so the
 * view can do reference-equality diffing.
 *
 * Updates of the same role coming back-to-back coalesce into one
 * transcript turn (e.g. multiple agent_message_chunk events from a
 * streaming response render as a single agent bubble). The first
 * update from a different role opens a new turn.
 */
export function applySessionUpdate(state: TranscriptState, update: SessionUpdate): TranscriptState {
  const role = roleForUpdate(update);
  if (!role) return state;

  const chunk = textForUpdate(update);
  if (chunk === null) return state;

  const lastIndex = state.turns.length - 1;
  const last = lastIndex >= 0 ? state.turns[lastIndex] : undefined;
  if (last && last.role === role) {
    const merged: TranscriptTurn = { ...last, text: last.text + chunk };
    const nextTurns = state.turns.slice(0, lastIndex).concat(merged);
    return { turns: nextTurns, nextId: state.nextId };
  }

  const fresh: TranscriptTurn = { id: state.nextId, role, text: chunk };
  return { turns: state.turns.concat(fresh), nextId: state.nextId + 1 };
}

function roleForUpdate(update: SessionUpdate): TranscriptRole | null {
  switch (update.sessionUpdate) {
    case "user_message_chunk":
      return "user";
    case "agent_message_chunk":
      return "agent";
    default:
      return null;
  }
}

function textForUpdate(update: SessionUpdate): string | null {
  if (
    update.sessionUpdate !== "user_message_chunk" &&
    update.sessionUpdate !== "agent_message_chunk"
  ) {
    return null;
  }
  const content = (update as { content?: unknown }).content;
  if (!content || typeof content !== "object") return null;
  const candidate = content as { type?: unknown; text?: unknown };
  if (candidate.type !== "text" || typeof candidate.text !== "string") {
    // M1 transcript only renders text content blocks. Non-text blocks
    // (image / audio / embedded resource) are dropped here; M3+ may
    // render them as inline thumbnails / tool-result widgets.
    return null;
  }
  return candidate.text;
}
