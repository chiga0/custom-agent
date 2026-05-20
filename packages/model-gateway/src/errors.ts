// Normalized provider error taxonomy. Each concrete provider adapter
// translates its SDK's native errors into one of these classes BEFORE
// raising them to the SessionEngine. The engine maps these to
// `turn.completed { stopReason: "error", errorCode: ... }` via the
// `toTurnErrorCode()` helper so all providers funnel through the same
// observability surface.
//
// Why a class hierarchy (not a tagged union):
//   - `instanceof` works across the adapter boundary even when the
//     class is re-exported through a re-export barrel.
//   - Each adapter's catch / translate logic stays terse: `throw new
//     ProviderRateLimit(...)` is shorter than constructing a discriminated
//     object.
//   - Tests can match on `.constructor.name` for golden diagnostics.

import type { TurnErrorCode } from "@custom-agent/schema";

export class ProviderError extends Error {
  /** Stable code for telemetry / log greps. Subclasses override. */
  readonly code: string = "provider_error";
  constructor(
    message: string,
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = "ProviderError";
  }
}

/**
 * Provider rate-limited the request. Caller MAY retry with backoff;
 * SessionEngine maps to `turn.completed { errorCode: "provider_failure" }`
 * — `provider_failure` is intentionally coarse in M2-01's schema; a richer
 * taxonomy (`rate_limit` / `5xx` / etc.) is reserved for M9a / M9b.
 */
export class ProviderRateLimit extends ProviderError {
  override readonly code = "rate_limit";
  constructor(
    message: string,
    public readonly retryAfterMs?: number,
    cause?: unknown,
  ) {
    super(message, cause);
    this.name = "ProviderRateLimit";
  }
}

/** Authentication failed (bad / missing / expired credentials). */
export class ProviderUnauthorized extends ProviderError {
  override readonly code = "unauthorized";
  constructor(message: string, cause?: unknown) {
    super(message, cause);
    this.name = "ProviderUnauthorized";
  }
}

/**
 * Request exceeds the provider's hard context window. This SHOULD be
 * caught by `preflightCheck` before the stream opens; if it surfaces at
 * stream time, the provider's tokenizer disagreed with `preflightCheck`
 * (likely a bug in the adapter). Maps to errorCode "context_overflow".
 */
export class ProviderContextOverflow extends ProviderError {
  override readonly code = "context_overflow";
  constructor(message: string, cause?: unknown) {
    super(message, cause);
    this.name = "ProviderContextOverflow";
  }
}

/** Provider 5xx / transient server-side failure. */
export class ProviderServerError extends ProviderError {
  override readonly code = "server_error";
  constructor(message: string, cause?: unknown) {
    super(message, cause);
    this.name = "ProviderServerError";
  }
}

/** Anything the adapter cannot classify; preserves the underlying cause. */
export class ProviderUnknownError extends ProviderError {
  override readonly code = "unknown";
  constructor(message: string, cause?: unknown) {
    super(message, cause);
    this.name = "ProviderUnknownError";
  }
}

/**
 * Translate a normalized ProviderError into the schema-level
 * TurnErrorCode SessionEngine writes into the turn.completed payload.
 * Open mapping — extend the schema's TurnErrorCode union together with
 * this function when richer codes are needed.
 */
export function toTurnErrorCode(error: ProviderError): TurnErrorCode {
  if (error instanceof ProviderContextOverflow) return "context_overflow";
  return "provider_failure";
}
