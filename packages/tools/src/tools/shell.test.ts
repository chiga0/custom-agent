import { describe, expect, it } from "vitest";
import { shellTool } from "./shell";
import type { ToolContext } from "../tool";

function makeCtx(cwd = process.cwd()): ToolContext {
  return {
    cwd,
    signal: new AbortController().signal,
    emit: () => {},
    budget: {
      take: (text: string) => text,
      truncated: false,
      bytesUsed: 0,
    } as any,
  };
}

describe("shellTool", () => {
  it("executes a simple command successfully", async () => {
    const chunks: string[] = [];
    const ctx: ToolContext = {
      ...makeCtx(),
      emit: (chunk) => { chunks.push(chunk.text); },
    };
    const result = await shellTool.execute({ command: "echo hello" }, ctx);
    expect(result.status).toBe("ok");
    expect(chunks.join("").trim()).toBe("hello");
  });

  it("denies dangerous commands from denylist", async () => {
    const result = await shellTool.execute({ command: "rm -rf /" }, makeCtx());
    expect(result.status).toBe("failed");
    expect((result as any).errorCode).toBe("permission_denied");
  });

  it("returns failure when command exits non-zero", async () => {
    const result = await shellTool.execute({ command: "exit 1" }, makeCtx());
    expect(result.status).toBe("failed");
  });

  it("has execute risk", () => {
    expect(shellTool.risk).toBe("execute");
  });
});
