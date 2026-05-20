import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { execSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { gitDiffTool } from "./git-diff";
import type { ToolContext } from "../tool";

function makeCtx(cwd: string): ToolContext {
  return {
    cwd,
    signal: new AbortController().signal,
    emit: () => {},
    budget: { take: (text: string) => text, truncated: false, bytesUsed: 0 } as any,
  };
}

describe("gitDiffTool", () => {
  it("returns ok for a clean repo (no diff)", async () => {
    const repoDir = `${process.cwd()}/git-diff-test-${Date.now()}`;
    try {
      mkdirSync(repoDir, { recursive: true });
      execSync("git init && git config user.email test@test.com && git config user.name Test", { cwd: repoDir });
      writeFileSync(`${repoDir}/test.txt`, "hello");
      execSync("git add . && git commit -m 'init'", { cwd: repoDir });

      const ctx = makeCtx(repoDir);
      const result = await gitDiffTool.execute({}, ctx);
      expect(result.status).toBe("ok");
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
    }
  });

  it("has read risk", () => {
    expect(gitDiffTool.risk).toBe("read");
  });
});
