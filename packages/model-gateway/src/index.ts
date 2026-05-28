// @custom-agent/model-gateway
//
// Provider adapters and provider-side error normalization. The Core
// `ModelProvider` port lives in `@custom-agent/core` — this package
// builds adapters AGAINST that port and is the canonical home for
// real-SDK integrations (M2-02b+).
//
// Layering:
//   - Errors (./errors.ts): normalized ProviderError hierarchy + the
//     `toTurnErrorCode` mapper used to bridge ProviderError into the
//     schema's TurnErrorCode union.
//   - Providers (./providers/*.ts): concrete adapters. M2-02a ships
//     RecordedProvider (fixture-replay, no network); M2-02b will add
//     real-SDK adapters.

export {
  ProviderError,
  ProviderRateLimit,
  ProviderUnauthorized,
  ProviderContextOverflow,
  ProviderServerError,
  ProviderUnknownError,
  toTurnErrorCode,
} from "./errors";

export {
  RecordedProvider,
  type ProviderFixture,
  type RecordedProviderEvent,
  type RecordedProviderError,
  type RecordedProviderOptions,
} from "./providers/recorded";

export { AnthropicProvider, type AnthropicProviderOptions } from "./providers/anthropic";
