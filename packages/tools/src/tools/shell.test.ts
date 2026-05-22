import { describe, expect, it } from "vitest";
import { shellTool } from "./shell";
import type { ToolContext } from "../tool";
import { BudgetAccumulator } from "../budget";

function makeCtx(cwd = process.cwd()): ToolContext {
  return {
    cwd,
    signal: new AbortController().signal,
    emit: () => {},
    budget: new BudgetAccumulator(),
  };
}

describe("shellTool", () => {
  it("executes a simple command successfully", async () => {
    const chunks: string[] = [];
    const ctx: ToolContext = {
      ...makeCtx(),
      emit: (chunk) => {
        chunks.push(chunk.text);
      },
    };
    const result = await shellTool.execute({ command: "echo hello" }, ctx);
    expect(result.status).toBe("ok");
    expect(chunks.join("").trim()).toBe("hello");
  });

  it("denies dangerous commands from denylist", async () => {
    const result = await shellTool.execute({ command: "rm -rf /" }, makeCtx());
    expect(result.status).toBe("failed");
    if (result.status === "failed") expect(result.errorCode).toBe("permission_denied");
  });

  it("returns failure when command exits non-zero", async () => {
    const result = await shellTool.execute({ command: "exit 1" }, makeCtx());
    expect(result.status).toBe("failed");
  });

  it("has execute risk", () => {
    expect(shellTool.risk).toBe("execute");
  });
});
