/** Browserkant van passkeys (WebAuthn) via @simplewebauthn/browser. */
import type { PasskeyOptions, PasskeyResponse } from "@panel/api";
import { browserSupportsWebAuthn, startAuthentication, startRegistration, type PublicKeyCredentialCreationOptionsJSON, type PublicKeyCredentialRequestOptionsJSON } from "@simplewebauthn/browser";
import { useSyncExternalStore } from "react";

/** true als deze browser WebAuthn kent (false tijdens server-rendering). */
export function usePasskeySupport(): boolean {
  return useSyncExternalStore(
    () => () => {},
    () => browserSupportsWebAuthn(),
    () => false,
  );
}

/** De gebruiker brak de browserdialoog af (of hij verliep). Geen echte fout. */
export class PasskeyCancelled extends Error {
  constructor() {
    super("PASSKEY_CANCELLED");
  }
}

const isCancel = (e: unknown) => e instanceof Error && (e.name === "NotAllowedError" || e.name === "AbortError" || (e as { code?: string }).code === "ERROR_CEREMONY_ABORTED");

export async function createPasskey(options: PasskeyOptions): Promise<PasskeyResponse> {
  try {
    return (await startRegistration({ optionsJSON: options as unknown as PublicKeyCredentialCreationOptionsJSON })) as unknown as PasskeyResponse;
  } catch (e) {
    throw isCancel(e) ? new PasskeyCancelled() : e;
  }
}

export async function getPasskey(options: PasskeyOptions): Promise<PasskeyResponse> {
  try {
    return (await startAuthentication({ optionsJSON: options as unknown as PublicKeyCredentialRequestOptionsJSON })) as unknown as PasskeyResponse;
  } catch (e) {
    throw isCancel(e) ? new PasskeyCancelled() : e;
  }
}
