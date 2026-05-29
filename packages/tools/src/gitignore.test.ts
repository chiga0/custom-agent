import { describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createIgnoreFilter } from "./gitignore";

async function makeTempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "gitignore-test-"));
}

describe("createIgnoreFilter", () => {
  it("filters built-in patterns even without a .gitignore file", async () => {
    const dir = await makeTempDir();
    try {
      const isIgnored = await createIgnoreFilter(dir);
      expect(isIgnored("node_modules/")).toBe(true);
      expect(isIgnored(".git/")).toBe(true);
      expect(isIgnored("dist/")).toBe(true);
      expect(isIgnored("src/main.ts")).toBe(false);
    } finally {
      await rm(dir, { recursive: true });
    }
  });

  it("respects .gitignore patterns", async () => {
    const dir = await makeTempDir();
    try {
      await writeFile(join(dir, ".gitignore"), "*.log\ntmp/\n");
      const isIgnored = await createIgnoreFilter(dir);
      expect(isIgnored("error.log")).toBe(true);
      expect(isIgnored("tmp/")).toBe(true);
      expect(isIgnored("src/app.ts")).toBe(false);
    } finally {
      await rm(dir, { recursive: true });
    }
  });

  it("supports negation patterns", async () => {
    const dir = await makeTempDir();
    try {
      await writeFile(join(dir, ".gitignore"), "*.log\n!important.log\n");
      const isIgnored = await createIgnoreFilter(dir);
      expect(isIgnored("debug.log")).toBe(true);
      expect(isIgnored("important.log")).toBe(false);
    } finally {
      await rm(dir, { recursive: true });
    }
  });

  it("handles subdirectory paths correctly", async () => {
    const dir = await makeTempDir();
    try {
      await writeFile(join(dir, ".gitignore"), "logs/\n");
      const isIgnored = await createIgnoreFilter(dir);
      expect(isIgnored("logs/")).toBe(true);
      expect(isIgnored("logs/app.log")).toBe(true);
      expect(isIgnored("src/logs.ts")).toBe(false);
    } finally {
      await rm(dir, { recursive: true });
    }
  });

  it("merges built-in patterns with .gitignore patterns", async () => {
    const dir = await makeTempDir();
    try {
      await writeFile(join(dir, ".gitignore"), "*.secret\n");
      const isIgnored = await createIgnoreFilter(dir);
      // Built-in still works
      expect(isIgnored("node_modules/")).toBe(true);
      // Custom pattern works too
      expect(isIgnored("config.secret")).toBe(true);
    } finally {
      await rm(dir, { recursive: true });
    }
  });

  it("does not filter regular source files", async () => {
    const dir = await makeTempDir();
    try {
      await writeFile(join(dir, ".gitignore"), "*.log\n");
      const isIgnored = await createIgnoreFilter(dir);
      expect(isIgnored("src/index.ts")).toBe(false);
      expect(isIgnored("package.json")).toBe(false);
      expect(isIgnored("README.md")).toBe(false);
    } finally {
      await rm(dir, { recursive: true });
    }
  });
});
