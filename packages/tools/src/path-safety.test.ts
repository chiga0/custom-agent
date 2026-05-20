import { describe, expect, it } from "vitest";
import { resolve } from "node:path";
import { resolveInsideCwd } from "./path-safety";

const CWD = resolve("/tmp/sess-cwd");

describe("resolveInsideCwd", () => {
  it("resolves a simple relative path inside cwd", () => {
    expect(resolveInsideCwd(CWD, "src/index.ts")).toBe(resolve(CWD, "src/index.ts"));
  });

  it("resolves '.' to cwd itself", () => {
    expect(resolveInsideCwd(CWD, ".")).toBe(resolve(CWD));
  });

  it("rejects ../ traversal", () => {
    expect(resolveInsideCwd(CWD, "../etc/passwd")).toBeUndefined();
    expect(resolveInsideCwd(CWD, "../../etc/passwd")).toBeUndefined();
    expect(resolveInsideCwd(CWD, "src/../../escape")).toBeUndefined();
  });

  it("accepts absolute paths that live inside cwd", () => {
    expect(resolveInsideCwd(CWD, resolve(CWD, "src"))).toBe(resolve(CWD, "src"));
  });

  it("rejects absolute paths outside cwd", () => {
    expect(resolveInsideCwd(CWD, "/etc/passwd")).toBeUndefined();
  });

  it("rejects sibling-prefix attack (cwd-evil)", () => {
    // resolve("/tmp/sess-cwd", "../sess-cwd-evil") = "/tmp/sess-cwd-evil"
    // startsWith("/tmp/sess-cwd") is true but path is OUTSIDE cwd. The
    // separator suffix check prevents this.
    expect(resolveInsideCwd(CWD, "/tmp/sess-cwd-evil/secret")).toBeUndefined();
  });

  it("rejects empty / null-ish but accepts cwd-relative ''", () => {
    // "" resolves to cwd itself, which is allowed (treat as listing cwd).
    expect(resolveInsideCwd(CWD, "")).toBe(resolve(CWD));
  });
});
