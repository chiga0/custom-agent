import { describe, expect, it } from "vitest";
import { AuthFailed, createAuthenticator } from "./auth";

describe("createAuthenticator", () => {
  it("rejects empty / whitespace tokens at construction", () => {
    expect(() => createAuthenticator("")).toThrow(/non-empty/);
    expect(() => createAuthenticator("   ")).toThrow(/non-empty/);
  });

  it("accepts a matching bearer token", () => {
    const auth = createAuthenticator("secret-token");
    expect(() => auth.check("Bearer secret-token")).not.toThrow();
  });

  it("rejects missing header", () => {
    const auth = createAuthenticator("secret-token");
    expect(() => auth.check(undefined)).toThrow(AuthFailed);
    expect(() => auth.check("")).toThrow(AuthFailed);
  });

  it("rejects wrong scheme", () => {
    const auth = createAuthenticator("secret-token");
    expect(() => auth.check("Basic secret-token")).toThrow(/Bearer scheme/);
  });

  it("rejects wrong token", () => {
    const auth = createAuthenticator("secret-token");
    expect(() => auth.check("Bearer wrong-token")).toThrow(/invalid bearer/);
  });

  it("rejects same-prefix shorter token (length mismatch)", () => {
    const auth = createAuthenticator("secret-token");
    expect(() => auth.check("Bearer secret")).toThrow(AuthFailed);
  });

  it("rejects same-prefix longer token", () => {
    const auth = createAuthenticator("secret-token");
    expect(() => auth.check("Bearer secret-tokenX")).toThrow(AuthFailed);
  });

  it("accepts the first value when given a header array", () => {
    const auth = createAuthenticator("secret-token");
    expect(() => auth.check(["Bearer secret-token", "Bearer other"])).not.toThrow();
  });
});
