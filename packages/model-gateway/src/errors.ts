// Re-export the ProviderError taxonomy that actually lives in
// `packages/core/src/ports/provider-error.ts`. The classes live in
// core so SessionEngine can `instanceof`-check them and translate to
// TurnErrorCode without a dependency edge into model-gateway. Adapter
// authors import from this barrel for ergonomics; the runtime values
// are the same identity, so `instanceof` works across both import
// paths.

export {
  ProviderError,
  ProviderRateLimit,
  ProviderUnauthorized,
  ProviderContextOverflow,
  ProviderServerError,
  ProviderUnknownError,
  toTurnErrorCode,
} from "@custom-agent/core";
