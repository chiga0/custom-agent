import { describe, expect, it } from "vitest";
import { applyPatchTool } from "./apply-patch";
import type { ToolContext } from "../tool";

function makeCtx(cwd = process.cwd()): ToolContext {
  return {
    cwd,
    signal: new AbortController().signal,
    emit: () => {},
    budget: { take: (text: string) => text, truncated: false, bytesUsed: 0 } as any,
  };
}

describe("applyPatchTool", () => {
  it("returns failure for empty patch", async () => {
    const result = await applyPatchTool.execute({ patch: "" }, makeCtx());
    expect(result.status).toBe("failed");
    expect((result as any).message).toContain("empty");
  });

  it("returns failure for whitespace-only patch", async () => {
    const result = await applyPatchTool.execute({ patch: "   " }, makeCtx());
    expect(result.status).toBe("failed");
  });

  it("has write risk", () => {
    expect(applyPatchTool.risk).toBe("write");
  });
});
