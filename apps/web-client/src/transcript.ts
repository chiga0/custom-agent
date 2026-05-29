import type { SessionUpdate } from "@custom-agent/schema/acp";

export type TranscriptRole = "user" | "agent" | "tool";

export type ToolCallInfo = {
  readonly toolCallId: string;
  title: string;
  status: string;
  kind: string;
  risk?: string;
  decision?: string;
  outcome?: string;
  outcomeSource?: string;
  input?: string;
  output: string;
  errorMessage?: string;
};

export type TranscriptTurn = {
  readonly id: number;
  readonly role: TranscriptRole;
  text: string;
  toolCall?: ToolCallInfo;
};

export type UsageInfo = {
  readonly used: number;
  readonly size: number;
};

export type TranscriptState = {
  readonly turns: readonly TranscriptTurn[];
  readonly nextId: number;
  readonly usage: UsageInfo | null;
};

export const EMPTY_TRANSCRIPT: TranscriptState = Object.freeze({
  turns: Object.freeze([]),
  nextId: 1,
  usage: null,
});

export function applySessionUpdate(state: TranscriptState, update: SessionUpdate): TranscriptState {
  if (update.sessionUpdate === "usage_update") {
    const u = update as unknown as { used: number; size: number };
    return { ...state, usage: { used: u.used, size: u.size } };
  }

  if (update.sessionUpdate === "tool_call") {
    return applyToolCall(state, update as unknown as ToolCallRaw);
  }

  if (update.sessionUpdate === "tool_call_update") {
    return applyToolCallUpdate(state, update as unknown as ToolCallUpdateRaw);
  }

  const role = roleForUpdate(update);
  if (!role) return state;

  const chunk = textForUpdate(update);
  if (chunk === null) return state;

  const lastIndex = state.turns.length - 1;
  const last = lastIndex >= 0 ? state.turns[lastIndex] : undefined;
  if (last && last.role === role) {
    const merged: TranscriptTurn = { ...last, text: last.text + chunk };
    const nextTurns = state.turns.slice(0, lastIndex).concat(merged);
    return { turns: nextTurns, nextId: state.nextId, usage: state.usage };
  }

  const fresh: TranscriptTurn = { id: state.nextId, role, text: chunk };
  return { turns: state.turns.concat(fresh), nextId: state.nextId + 1, usage: state.usage };
}

// ---- tool_call / tool_call_update ----

type ToolCallRaw = {
  sessionUpdate: "tool_call";
  toolCallId?: string;
  title?: string;
  status?: string;
  kind?: string;
  rawInput?: string;
  _meta?: { risk?: string; decision?: string };
};

type ToolCallUpdateRaw = {
  sessionUpdate: "tool_call_update";
  toolCallId?: string;
  status?: string;
  rawInput?: string;
  content?: { type: string; content?: { type: string; text?: string } }[];
  _meta?: { outcome?: string; source?: string; errorCode?: string; message?: string };
};

function applyToolCall(state: TranscriptState, raw: ToolCallRaw): TranscriptState {
  const toolCallId = raw.toolCallId ?? "";
  if (!toolCallId) return state;

  const toolCall: ToolCallInfo = {
    toolCallId,
    title: raw.title ?? "tool",
    status: raw.status ?? "pending",
    kind: raw.kind ?? "other",
    risk: raw._meta?.risk,
    decision: raw._meta?.decision,
    output: "",
  };
  if (raw.rawInput) toolCall.input = raw.rawInput;

  const turn: TranscriptTurn = { id: state.nextId, role: "tool", text: "", toolCall };
  return { turns: state.turns.concat(turn), nextId: state.nextId + 1, usage: state.usage };
}

function applyToolCallUpdate(state: TranscriptState, raw: ToolCallUpdateRaw): TranscriptState {
  const toolCallId = raw.toolCallId ?? "";
  if (!toolCallId) return state;

  const idx = findToolTurnIndex(state.turns, toolCallId);
  if (idx < 0) return state;

  const turn = state.turns[idx];
  const tc = { ...turn.toolCall! };

  if (raw.status) tc.status = raw.status;
  if (raw.rawInput) tc.input = raw.rawInput;
  if (raw._meta?.outcome) tc.outcome = raw._meta.outcome;
  if (raw._meta?.source) tc.outcomeSource = raw._meta.source;
  if (raw._meta?.message) tc.errorMessage = raw._meta.message;

  const text = extractContentText(raw.content);
  if (text) tc.output += text;

  const updated: TranscriptTurn = { ...turn, toolCall: tc };
  const turns = state.turns
    .slice(0, idx)
    .concat(updated)
    .concat(state.turns.slice(idx + 1));
  return { turns, nextId: state.nextId, usage: state.usage };
}

function findToolTurnIndex(turns: readonly TranscriptTurn[], toolCallId: string): number {
  for (let i = turns.length - 1; i >= 0; i--) {
    if (turns[i].toolCall?.toolCallId === toolCallId) return i;
  }
  return -1;
}

function extractContentText(
  content?: { type: string; content?: { type: string; text?: string } }[],
): string {
  if (!content) return "";
  let out = "";
  for (const block of content) {
    if (block.content && block.content.type === "text" && block.content.text) {
      out += block.content.text;
    }
  }
  return out;
}

// ---- message chunk helpers ----

function roleForUpdate(update: SessionUpdate): "user" | "agent" | null {
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
  if (candidate.type !== "text" || typeof candidate.text !== "string") return null;
  return candidate.text;
}
