// Phase 2 stub: passkeys/WebAuthn or TOTP as a second factor. No routes use this yet.
export type SecondFactorKind = 'webauthn' | 'totp';

export interface SecondFactorChallenge {
  kind: SecondFactorKind;
  /** Opaque, server-generated challenge data (e.g. WebAuthn options). */
  payload?: unknown;
}

export interface SecondFactorProvider {
  readonly kind: SecondFactorKind;
  /** Whether a factor has been enrolled for the owner. */
  isEnrolled(): Promise<boolean>;
  /** Begin verification after the password step. */
  begin(): Promise<SecondFactorChallenge>;
  /** Complete verification; resolve true when the response is valid. */
  verify(response: unknown): Promise<boolean>;
}

/** Default: no second factor required. */
export const noopSecondFactor: SecondFactorProvider = {
  kind: 'totp',
  isEnrolled: async () => false,
  begin: async () => ({ kind: 'totp' }),
  verify: async () => true,
};
