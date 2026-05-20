import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFileTool } from "./read-file";
import { BudgetAccumulator } from "../budget";
import type { ToolChunk } from "../tool";

describe("read_file tool", () => {
  let cwd = "";
  beforeEach(async () => {
    cwd = await mkdtemp(join(tmpdir(), "read-file-tool-"));
  });
  afterEach(async () => {
    if (cwd) await rm(cwd, { recursive: true, force: true });
  });

  function makeCtx(): { chunks: ToolChunk[]; ctx: Parameters<typeof readFileTool.execute>[1] } {
    const chunks: ToolChunk[] = [];
    const ctx = {
      cwd,
      signal: new AbortController().signal,
      emit: (c: ToolChunk) => chunks.push(c),
      budget: new BudgetAccumulator(),
    };
    return { chunks, ctx };
  }

  it("reads a UTF-8 file relative to cwd", async () => {
    await writeFile(join(cwd, "hello.txt"), "Hello, world.\n", "utf8");
    const { chunks, ctx } = makeCtx();
    const out = await readFileTool.execute({ path: "hello.txt" }, ctx);
    expect(out.status).toBe("ok");
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toEqual({ kind: "result", text: "Hello, world.\n" });
  });

  it("rejects path traversal with errorCode=path_unsafe", async () => {
    const { ctx } = makeCtx();
    const out = await readFileTool.execute({ path: "../../etc/passwd" }, ctx);
    expect(out.status).toBe("failed");
    if (out.status === "failed") expect(out.errorCode).toBe("path_unsafe");
  });

  it("ENOENT maps to errorCode=not_found", async () => {
    const { ctx } = makeCtx();
    const out = await readFileTool.execute({ path: "missing.txt" }, ctx);
    expect(out.status).toBe("failed");
    if (out.status === "failed") expect(out.errorCode).toBe("not_found");
  });

  it("directory target maps to errorCode=io_error", async () => {
    await mkdir(join(cwd, "subdir"));
    const { ctx } = makeCtx();
    const out = await readFileTool.execute({ path: "subdir" }, ctx);
    expect(out.status).toBe("failed");
    if (out.status === "failed") expect(out.errorCode).toBe("io_error");
  });
});
