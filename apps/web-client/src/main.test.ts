import { describe, expect, it } from "vitest";
import { renderTranscriptHtml, looksLikeDiff, renderDiffBlock, renderToolOutput } from "./main";
import { EMPTY_TRANSCRIPT, applySessionUpdate } from "./transcript";
import type { SessionUpdate } from "@custom-agent/schema/acp";

function user(text: string): SessionUpdate {
  return { sessionUpdate: "user_message_chunk", content: { type: "text", text } };
}

function agent(text: string): SessionUpdate {
  return { sessionUpdate: "agent_message_chunk", content: { type: "text", text } };
}

function toolCall(toolCallId: string, title: string, kind = "read"): SessionUpdate {
  return {
    sessionUpdate: "tool_call",
    toolCallId,
    title,
    status: "pending",
    kind,
    _meta: { risk: "read", decision: "auto-allow" },
  } as unknown as SessionUpdate;
}

function toolCallUpdate(toolCallId: string, fields: Record<string, unknown> = {}): SessionUpdate {
  return { sessionUpdate: "tool_call_update", toolCallId, ...fields } as unknown as SessionUpdate;
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

  it("renders a tool card for tool turns", () => {
    let s = EMPTY_TRANSCRIPT;
    s = applySessionUpdate(s, toolCall("tc_1", "read_file", "read"));
    s = applySessionUpdate(
      s,
      toolCallUpdate("tc_1", { status: "in_progress", rawInput: "/tmp/x" }),
    );
    const html = renderTranscriptHtml(s);
    expect(html).toContain('class="turn turn--tool"');
    expect(html).toContain("read_file");
    expect(html).toContain("in_progress");
    expect(html).toContain("/tmp/x");
  });

  it("renders tool output with diff highlighting when output looks like a diff", () => {
    let s = EMPTY_TRANSCRIPT;
    s = applySessionUpdate(s, toolCall("tc_1", "git_diff", "read"));
    s = applySessionUpdate(
      s,
      toolCallUpdate("tc_1", {
        content: [
          {
            type: "content",
            content: {
              type: "text",
              text: "diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1 +1 @@\n-old\n+new",
            },
          },
        ],
      }),
    );
    const html = renderTranscriptHtml(s);
    expect(html).toContain("diff-add");
    expect(html).toContain("diff-del");
    expect(html).toContain("diff-hunk");
  });

  it("renders tool error message", () => {
    let s = EMPTY_TRANSCRIPT;
    s = applySessionUpdate(s, toolCall("tc_1", "shell"));
    s = applySessionUpdate(
      s,
      toolCallUpdate("tc_1", { status: "failed", _meta: { message: "Command timed out" } }),
    );
    const html = renderTranscriptHtml(s);
    expect(html).toContain("Command timed out");
    expect(html).toContain("tool-error");
  });

  it("renders permission audit trail", () => {
    let s = EMPTY_TRANSCRIPT;
    s = applySessionUpdate(s, toolCall("tc_1", "shell", "execute"));
    s = applySessionUpdate(
      s,
      toolCallUpdate("tc_1", { _meta: { outcome: "allowed", source: "user" } }),
    );
    const html = renderTranscriptHtml(s);
    expect(html).toContain("tool-audit");
    expect(html).toContain("outcome=allowed");
    expect(html).toContain("source=user");
  });
});

describe("looksLikeDiff", () => {
  it("detects diff --git header", () => {
    expect(looksLikeDiff("diff --git a/foo b/foo\n--- a/foo")).toBe(true);
  });

  it("detects --- / +++ pair without diff --git", () => {
    expect(looksLikeDiff("--- a/file\n+++ b/file\n@@ -1 +1 @@")).toBe(true);
  });

  it("rejects plain text", () => {
    expect(looksLikeDiff("Hello world\nnothing special")).toBe(false);
  });
});

describe("renderDiffBlock", () => {
  it("wraps added lines with diff-add class", () => {
    const html = renderDiffBlock("+added line");
    expect(html).toContain('class="diff-add"');
    expect(html).toContain("+added line");
  });

  it("wraps removed lines with diff-del class", () => {
    const html = renderDiffBlock("-removed line");
    expect(html).toContain('class="diff-del"');
  });

  it("wraps hunk headers with diff-hunk class", () => {
    const html = renderDiffBlock("@@ -1,3 +1,4 @@");
    expect(html).toContain('class="diff-hunk"');
  });

  it("does not classify --- or +++ header lines as add/del", () => {
    const html = renderDiffBlock("--- a/file\n+++ b/file");
    expect(html).not.toContain("diff-add");
    expect(html).not.toContain("diff-del");
  });
});

describe("renderToolOutput", () => {
  it("uses diff rendering for diff-like output", () => {
    const html = renderToolOutput("diff --git a/x b/x\n-old\n+new");
    expect(html).toContain("tool-output--diff");
  });

  it("uses plain code block for non-diff output", () => {
    const html = renderToolOutput("just some text");
    expect(html).toContain("tool-output");
    expect(html).not.toContain("tool-output--diff");
  });
});
