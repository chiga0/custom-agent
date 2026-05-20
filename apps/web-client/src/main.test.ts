import { describe, expect, it } from "vitest";
import { renderTranscriptHtml } from "./main";
import { EMPTY_TRANSCRIPT, applySessionUpdate } from "./transcript";
import type { SessionUpdate } from "@custom-agent/schema/acp";

// main.test.ts
//
// Tests the pure rendering helper that the DOM layer uses. Side-effecting
// code (fetch, EventSource, button bindings) is exercised via
// daemon-client.test.ts + transcript.test.ts; here we only assert the
// view's serialization contract.

function user(text: string): SessionUpdate {
  return { sessionUpdate: "user_message_chunk", content: { type: "text", text } };
}

function agent(text: string): SessionUpdate {
  return { sessionUpdate: "agent_message_chunk", content: { type: "text", text } };
}

describe("renderTranscriptHtml", () => {
  it("renders an empty placeholder when there are no turns", () => {
    const html = renderTranscriptHtml(EMPTY_TRANSCRIPT);
    expect(html).toContain('class="empty"');
  });

  it("emits one article per turn with role-tagged class", () => {
    let s = EMPTY_TRANSCRIPT;
    s = applySessionUpdate(s, user("hi"));
    s = applySessionUpdate(s, agent("hello"));
    const html = renderTranscriptHtml(s);
    expect(html).toContain('class="turn turn--user"');
    expect(html).toContain('class="turn turn--agent"');
    expect(html).toContain("<p>hi</p>");
    expect(html).toContain("<p>hello</p>");
  });

  it("escapes HTML in user-supplied content so a hostile chunk cannot inject markup", () => {
    let s = EMPTY_TRANSCRIPT;
    s = applySessionUpdate(s, agent("<script>alert(1)</script>"));
    const html = renderTranscriptHtml(s);
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
  });
});
