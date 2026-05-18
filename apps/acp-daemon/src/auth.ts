import { timingSafeEqual } from "node:crypto";

// Bearer-token check for /rpc + /events.
//
// SPEC.md §3: the daemon refuses to start without ACP_DAEMON_AUTH_TOKEN
// (fail-closed); every gated request must present a matching
// `Authorization: Bearer <token>` header. Comparison is constant-time so a
// timing oracle can't lift the token byte-by-byte.

const BEARER_PREFIX = "Bearer ";

export class AuthFailed extends Error {
  readonly status = 401;
  constructor(message: string) {
    super(message);
    this.name = "AuthFailed";
  }
}

export type Authenticator = {
  /** Throws AuthFailed on mismatch; returns void on success. */
  check(authHeader: string | undefined | string[]): void;
};

/**
 * Constant-time bearer-token authenticator.
 * The expected token is the entire credential after "Bearer ".
 */
export function createAuthenticator(expectedToken: string): Authenticator {
  if (!expectedToken || expectedToken.trim().length === 0) {
    throw new Error("ACP_DAEMON_AUTH_TOKEN must be a non-empty string");
  }
  const expectedBuf = Buffer.from(expectedToken);
  return {
    check(authHeader) {
      const value = Array.isArray(authHeader) ? authHeader[0] : authHeader;
      if (!value) {
        throw new AuthFailed("missing Authorization header");
      }
      if (!value.startsWith(BEARER_PREFIX)) {
        throw new AuthFailed("Authorization header must use the Bearer scheme");
      }
      const presented = value.slice(BEARER_PREFIX.length);
      const presentedBuf = Buffer.from(presented);
      // timingSafeEqual requires equal-length buffers. Pad the shorter
      // one with zeros and additionally check the original lengths so
      // distinct lengths still fail.
      const a = Buffer.alloc(Math.max(expectedBuf.length, presentedBuf.length));
      const b = Buffer.alloc(a.length);
      expectedBuf.copy(a);
      presentedBuf.copy(b);
      const equalContent = timingSafeEqual(a, b);
      const equalLength = expectedBuf.length === presentedBuf.length;
      if (!equalContent || !equalLength) {
        throw new AuthFailed("invalid bearer token");
      }
    },
  };
}
