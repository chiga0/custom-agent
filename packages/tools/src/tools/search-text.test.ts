import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { searchTextTool } from "./search-text";
import { BudgetAccumulator } from "../budget";
import type { ToolChunk } from "../tool";

describe("search_text tool", () => {
  let cwd = "";
  beforeEach(async () => {
    cwd = await mkdtemp(join(tmpdir(), "search-text-tool-"));
  });
  afterEach(async () => {
    if (cwd) await rm(cwd, { recursive: true, force: true });
  });

  function makeCtx(): { chunks: ToolChunk[]; ctx: Parameters<typeof searchTextTool.execute>[1] } {
    const chunks: ToolChunk[] = [];
    const ctx = {
      cwd,
      signal: new AbortController().signal,
      emit: (c: ToolChunk) => chunks.push(c),
      budget: new BudgetAccumulator(),
    };
    return { chunks, ctx };
  }

  it("returns relpath:line:text for each literal hit", async () => {
    await writeFile(
      join(cwd, "a.ts"),
      "first line\nfoo hit one\nsecond line\nfoo hit two\n",
      "utf8",
    );
    const { chunks, ctx } = makeCtx();
    const out = await searchTextTool.execute({ query: "foo" }, ctx);
    expect(out.status).toBe("ok");
    const lines = chunks[0]?.text.split("\n").filter(Boolean) ?? [];
    expect(lines).toEqual(["a.ts:2:foo hit one", "a.ts:4:foo hit two"]);
  });

  it("recurses subdirectories but skips node_modules", async () => {
    await mkdir(join(cwd, "src"));
    await writeFile(join(cwd, "src", "x.ts"), "marker here\n", "utf8");
    await mkdir(join(cwd, "node_modules", "noisy"), { recursive: true });
    await writeFile(join(cwd, "node_modules", "noisy", "y.ts"), "marker here\n", "utf8");
    const { chunks, ctx } = makeCtx();
    await searchTextTool.execute({ query: "marker" }, ctx);
    const lines = chunks[0]?.text.split("\n").filter(Boolean) ?? [];
    expect(lines).toEqual(["src/x.ts:1:marker here"]);
  });

  it("caseInsensitive flag matches case-folded", async () => {
    await writeFile(join(cwd, "a.ts"), "HELLO World\nhello world\n", "utf8");
    const { chunks, ctx } = makeCtx();
    await searchTextTool.execute({ query: "hello", caseInsensitive: true }, ctx);
    const lines = chunks[0]?.text.split("\n").filter(Boolean) ?? [];
    expect(lines).toHaveLength(2);
  });

  it("maxMatches caps the result count", async () => {
    const big = Array.from({ length: 50 }, (_, i) => `match ${i}`).join("\n") + "\n";
    await writeFile(join(cwd, "a.ts"), big, "utf8");
    const { chunks, ctx } = makeCtx();
    await searchTextTool.execute({ query: "match", maxMatches: 5 }, ctx);
    const lines = chunks[0]?.text.split("\n").filter(Boolean) ?? [];
    expect(lines).toHaveLength(5);
  });

  it("skips binary-looking extensions (e.g. .png)", async () => {
    await writeFile(join(cwd, "a.ts"), "needle in source\n", "utf8");
    await writeFile(join(cwd, "img.png"), "needle in binary\n", "utf8");
    const { chunks, ctx } = makeCtx();
    await searchTextTool.execute({ query: "needle" }, ctx);
    const lines = chunks[0]?.text.split("\n").filter(Boolean) ?? [];
    expect(lines).toEqual(["a.ts:1:needle in source"]);
  });

  it("path traversal rejected with path_unsafe", async () => {
    const { ctx } = makeCtx();
    const out = await searchTextTool.execute({ query: "x", path: "../../etc" }, ctx);
    expect(out.status).toBe("failed");
    if (out.status === "failed") expect(out.errorCode).toBe("path_unsafe");
  });

  it("empty query rejected with io_error", async () => {
    const { ctx } = makeCtx();
    const out = await searchTextTool.execute({ query: "" }, ctx);
    expect(out.status).toBe("failed");
    if (out.status === "failed") expect(out.errorCode).toBe("io_error");
  });

  it("missing path rejected with not_found", async () => {
    const { ctx } = makeCtx();
    const out = await searchTextTool.execute({ query: "x", path: "nope" }, ctx);
    expect(out.status).toBe("failed");
    if (out.status === "failed") expect(out.errorCode).toBe("not_found");
  });
});
