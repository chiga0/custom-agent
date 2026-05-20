import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listFilesTool } from "./list-files";
import { BudgetAccumulator } from "../budget";
import type { ToolChunk } from "../tool";

describe("list_files tool", () => {
  let cwd = "";
  beforeEach(async () => {
    cwd = await mkdtemp(join(tmpdir(), "list-files-tool-"));
  });
  afterEach(async () => {
    if (cwd) await rm(cwd, { recursive: true, force: true });
  });

  function makeCtx(): { chunks: ToolChunk[]; ctx: Parameters<typeof listFilesTool.execute>[1] } {
    const chunks: ToolChunk[] = [];
    const ctx = {
      cwd,
      signal: new AbortController().signal,
      emit: (c: ToolChunk) => chunks.push(c),
      budget: new BudgetAccumulator(),
    };
    return { chunks, ctx };
  }

  function lines(chunks: ToolChunk[]): string[] {
    return chunks[0]?.text.split("\n").filter(Boolean) ?? [];
  }

  it("lists top-level files in sorted order", async () => {
    await writeFile(join(cwd, "b.txt"), "");
    await writeFile(join(cwd, "a.txt"), "");
    const { chunks, ctx } = makeCtx();
    const out = await listFilesTool.execute({}, ctx);
    expect(out.status).toBe("ok");
    expect(lines(chunks)).toEqual(["a.txt", "b.txt"]);
  });

  it("directory entries get trailing slash", async () => {
    await mkdir(join(cwd, "subdir"));
    await writeFile(join(cwd, "file.txt"), "");
    const { chunks, ctx } = makeCtx();
    await listFilesTool.execute({}, ctx);
    expect(lines(chunks)).toEqual(["file.txt", "subdir/"]);
  });

  it("recursive: walks into subdirs but skips node_modules and .git", async () => {
    await mkdir(join(cwd, "src"));
    await writeFile(join(cwd, "src", "index.ts"), "");
    await mkdir(join(cwd, "node_modules", "noisy"), { recursive: true });
    await writeFile(join(cwd, "node_modules", "noisy", "file.js"), "");
    await mkdir(join(cwd, ".git"));
    await writeFile(join(cwd, ".git", "HEAD"), "");
    const { chunks, ctx } = makeCtx();
    await listFilesTool.execute({ recursive: true }, ctx);
    const ls = lines(chunks);
    expect(ls).toContain("src/");
    expect(ls).toContain("src/index.ts");
    expect(ls.every((l) => !l.startsWith("node_modules"))).toBe(true);
    expect(ls.every((l) => !l.startsWith(".git"))).toBe(true);
  });

  it("skipHidden=false includes dotfiles", async () => {
    await writeFile(join(cwd, ".env.example"), "");
    await writeFile(join(cwd, "visible.txt"), "");
    const { chunks, ctx } = makeCtx();
    await listFilesTool.execute({ skipHidden: false }, ctx);
    expect(lines(chunks)).toContain(".env.example");
  });

  it("path traversal rejected with path_unsafe", async () => {
    const { ctx } = makeCtx();
    const out = await listFilesTool.execute({ path: "../../etc" }, ctx);
    expect(out.status).toBe("failed");
    if (out.status === "failed") expect(out.errorCode).toBe("path_unsafe");
  });

  it("missing directory maps to not_found", async () => {
    const { ctx } = makeCtx();
    const out = await listFilesTool.execute({ path: "no_such_dir" }, ctx);
    expect(out.status).toBe("failed");
    if (out.status === "failed") expect(out.errorCode).toBe("not_found");
  });

  it("file (not directory) target maps to io_error", async () => {
    await writeFile(join(cwd, "a.txt"), "");
    const { ctx } = makeCtx();
    const out = await listFilesTool.execute({ path: "a.txt" }, ctx);
    expect(out.status).toBe("failed");
    if (out.status === "failed") expect(out.errorCode).toBe("io_error");
  });
});
