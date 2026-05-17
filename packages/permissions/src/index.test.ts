import { describe, expect, it } from "vitest";
import { classifyPermission } from "./index";

describe("permission classification", () => {
  it("allows read-only actions by default", () => {
    expect(
      classifyPermission({
        toolName: "read_file",
        risk: "read",
        reason: "Read-only project inspection",
      }),
    ).toBe("allow");
  });

  it("asks before write or execute actions by default", () => {
    expect(
      classifyPermission({
        toolName: "shell",
        risk: "execute",
        reason: "Command execution",
      }),
    ).toBe("ask");
  });
});
