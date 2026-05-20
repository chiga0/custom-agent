import { describe, expect, it } from "vitest";
import {
  ProviderContextOverflow,
  ProviderError,
  ProviderRateLimit,
  ProviderServerError,
  ProviderUnauthorized,
  ProviderUnknownError,
  toTurnErrorCode,
} from "./errors";

describe("ProviderError taxonomy", () => {
  it("each subclass is an instance of ProviderError", () => {
    expect(new ProviderRateLimit("x")).toBeInstanceOf(ProviderError);
    expect(new ProviderUnauthorized("x")).toBeInstanceOf(ProviderError);
    expect(new ProviderContextOverflow("x")).toBeInstanceOf(ProviderError);
    expect(new ProviderServerError("x")).toBeInstanceOf(ProviderError);
    expect(new ProviderUnknownError("x")).toBeInstanceOf(ProviderError);
  });

  it("each subclass carries a stable code + name for log grepping", () => {
    expect(new ProviderRateLimit("x").code).toBe("rate_limit");
    expect(new ProviderRateLimit("x").name).toBe("ProviderRateLimit");
    expect(new ProviderUnauthorized("x").code).toBe("unauthorized");
    expect(new ProviderContextOverflow("x").code).toBe("context_overflow");
    expect(new ProviderServerError("x").code).toBe("server_error");
    expect(new ProviderUnknownError("x").code).toBe("unknown");
  });

  it("ProviderRateLimit preserves retryAfterMs", () => {
    const err = new ProviderRateLimit("slow down", 5000);
    expect(err.retryAfterMs).toBe(5000);
  });

  it("preserves the original cause for diagnostics", () => {
    const cause = new Error("native sdk");
    const err = new ProviderServerError("upstream 502", cause);
    expect(err.cause).toBe(cause);
  });
});

describe("toTurnErrorCode", () => {
  it("maps ProviderContextOverflow to context_overflow", () => {
    expect(toTurnErrorCode(new ProviderContextOverflow("over"))).toBe("context_overflow");
  });

  it("maps every other ProviderError variant to provider_failure", () => {
    expect(toTurnErrorCode(new ProviderRateLimit("rl"))).toBe("provider_failure");
    expect(toTurnErrorCode(new ProviderUnauthorized("auth"))).toBe("provider_failure");
    expect(toTurnErrorCode(new ProviderServerError("5xx"))).toBe("provider_failure");
    expect(toTurnErrorCode(new ProviderUnknownError("?"))).toBe("provider_failure");
  });
});
