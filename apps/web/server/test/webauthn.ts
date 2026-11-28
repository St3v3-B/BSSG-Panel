/**
 * Software-authenticator voor tests: maakt echte WebAuthn-responses (ES256, attestation "none")
 * met node:crypto, zodat @simplewebauthn/server de volledige verificatie doorloopt.
 */
import { createHash, generateKeyPairSync, randomBytes, sign, type KeyObject } from "node:crypto";

// ---------- minimale CBOR-encoder (genoeg voor COSE-sleutel en attestationObject) ----------

type Cbor = number | string | Uint8Array | Cbor[] | Map<number | string, Cbor> | { [k: string]: Cbor };

function head(major: number, n: number): Buffer {
  if (n < 24) return Buffer.from([(major << 5) | n]);
  if (n < 0x100) return Buffer.from([(major << 5) | 24, n]);
  if (n < 0x10000) {
    const b = Buffer.alloc(3);
    b[0] = (major << 5) | 25;
    b.writeUInt16BE(n, 1);
    return b;
  }
  const b = Buffer.alloc(5);
  b[0] = (major << 5) | 26;
  b.writeUInt32BE(n, 1);
  return b;
}

export function cbor(v: Cbor): Buffer {
  if (typeof v === "number") return v >= 0 ? head(0, v) : head(1, -1 - v);
  if (typeof v === "string") {
    const s = Buffer.from(v, "utf8");
    return Buffer.concat([head(3, s.length), s]);
  }
  if (v instanceof Uint8Array) return Buffer.concat([head(2, v.length), Buffer.from(v)]);
  if (Array.isArray(v)) return Buffer.concat([head(4, v.length), ...v.map(cbor)]);
  const entries = v instanceof Map ? [...v.entries()] : Object.entries(v);
  return Buffer.concat([head(5, entries.length), ...entries.flatMap(([k, x]) => [cbor(k), cbor(x)])]);
}

const b64u = (b: Uint8Array | string) => Buffer.from(b).toString("base64url");
const sha = (b: Uint8Array | string) => createHash("sha256").update(b).digest();

export interface SoftAuthenticatorOpts {
  rpId?: string;
  origin?: string;
  /** Meld user verification (UV-flag). Standaard true. */
  userVerified?: boolean;
  backedUp?: boolean;
}

/** Eén passkey (credential) op een nep-authenticator. */
export class SoftPasskey {
  readonly credentialId: Buffer = randomBytes(32);
  readonly key: { privateKey: KeyObject; publicKey: KeyObject } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  counter = 0;
  userHandle: string | null = null;
  rpId: string;
  origin: string;
  userVerified: boolean;
  backedUp: boolean;

  constructor(o: SoftAuthenticatorOpts = {}) {
    this.rpId = o.rpId ?? "panel.test";
    this.origin = o.origin ?? `https://${this.rpId}`;
    this.userVerified = o.userVerified ?? true;
    this.backedUp = o.backedUp ?? false;
  }

  get id(): string {
    return b64u(this.credentialId);
  }

  private coseKey(): Buffer {
    const jwk = this.key.publicKey.export({ format: "jwk" });
    return cbor(new Map<number, Cbor>([[1, 2], [3, -7], [-1, 1], [-2, Buffer.from(jwk.x!, "base64url")], [-3, Buffer.from(jwk.y!, "base64url")]]));
  }

  private authData(o: { attested: boolean; rpId: string; userVerified: boolean }): Buffer {
    const flags = 0x01 | (o.userVerified ? 0x04 : 0) | (this.backedUp ? 0x18 : 0) | (o.attested ? 0x40 : 0);
    const cnt = Buffer.alloc(4);
    cnt.writeUInt32BE(this.counter);
    const parts: Buffer[] = [sha(o.rpId), Buffer.from([flags]), cnt];
    if (o.attested) {
      const len = Buffer.alloc(2);
      len.writeUInt16BE(this.credentialId.length);
      parts.push(Buffer.alloc(16), len, this.credentialId, this.coseKey());
    }
    return Buffer.concat(parts);
  }

  private clientData(type: string, challenge: string, origin: string): Buffer {
    return Buffer.from(JSON.stringify({ type, challenge, origin, crossOrigin: false }));
  }

  /** RegistrationResponseJSON voor de opties uit registerOptions. */
  register(options: { challenge: string; user?: { id?: string } }, over: { origin?: string; rpId?: string; challenge?: string; userVerified?: boolean } = {}) {
    if (options.user?.id) this.userHandle = options.user.id;
    const clientDataJSON = this.clientData("webauthn.create", over.challenge ?? options.challenge, over.origin ?? this.origin);
    const authData = this.authData({ attested: true, rpId: over.rpId ?? this.rpId, userVerified: over.userVerified ?? this.userVerified });
    const attestationObject = cbor({ fmt: "none", attStmt: {}, authData });
    return {
      id: this.id,
      rawId: this.id,
      type: "public-key" as const,
      response: { clientDataJSON: b64u(clientDataJSON), attestationObject: b64u(attestationObject), transports: ["internal", "hybrid"] },
      clientExtensionResults: {},
      authenticatorAttachment: "platform",
    };
  }

  /** AuthenticationResponseJSON; verhoogt de teller tenzij `counter` gegeven is. */
  assert(options: { challenge: string }, over: { origin?: string; rpId?: string; challenge?: string; userVerified?: boolean; counter?: number; userHandle?: string | null } = {}) {
    if (over.counter !== undefined) this.counter = over.counter;
    else this.counter++;
    const clientDataJSON = this.clientData("webauthn.get", over.challenge ?? options.challenge, over.origin ?? this.origin);
    const authData = this.authData({ attested: false, rpId: over.rpId ?? this.rpId, userVerified: over.userVerified ?? this.userVerified });
    const signature = sign("sha256", Buffer.concat([authData, sha(clientDataJSON)]), this.key.privateKey);
    const userHandle = over.userHandle === undefined ? this.userHandle : over.userHandle;
    return {
      id: this.id,
      rawId: this.id,
      type: "public-key" as const,
      response: { clientDataJSON: b64u(clientDataJSON), authenticatorData: b64u(authData), signature: b64u(signature), ...(userHandle ? { userHandle } : {}) },
      clientExtensionResults: {},
      authenticatorAttachment: "platform",
    };
  }
}
