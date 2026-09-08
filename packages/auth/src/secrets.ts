/**
 * Shared-secret helpers for cron / webhook bearer tokens.
 * Works in both Node and Workers (no `node:crypto` dependency).
 */

/** Production guidance: configure cron/webhook secrets at least this long. */
export const MIN_SHARED_SECRET_LENGTH = 32;

/**
 * Constant-time string equality. Length mismatch returns false without
 * leaking which side was longer beyond the early exit (unavoidable).
 */
export function timingSafeEqualString(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i++) {
    mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return mismatch === 0;
}

export type VerifySharedSecretOptions = {
  /** Defaults to {@link MIN_SHARED_SECRET_LENGTH}. */
  minLength?: number;
};

/**
 * Fail-closed shared-secret check.
 * - Missing / empty / short *configured* secret → always reject (never process).
 * - Missing provided secret → reject.
 * - Otherwise timing-safe compare.
 */
export function verifySharedSecret(
  provided: string | null | undefined,
  expected: string | null | undefined,
  options?: VerifySharedSecretOptions,
): boolean {
  const minLength = options?.minLength ?? MIN_SHARED_SECRET_LENGTH;
  if (typeof expected !== "string" || expected.length < minLength) return false;
  if (typeof provided !== "string" || provided.length === 0) return false;
  return timingSafeEqualString(provided, expected);
}
