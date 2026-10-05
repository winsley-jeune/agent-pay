import { createHash, generateKeyPairSync, randomBytes, sign, type KeyObject } from "node:crypto";

// A software WebAuthn authenticator, so tests exercise real passkey
// registration and signature verification without a browser or device.

type Cbor = number | string | Uint8Array | Cbor[] | Map<Cbor, Cbor> | { [k: string]: Cbor };

function head(major: number, n: number): Buffer {
  if (n < 24) return Buffer.from([(major << 5) | n]);
  if (n < 256) return Buffer.from([(major << 5) | 24, n]);
  if (n < 65536) return Buffer.from([(major << 5) | 25, n >> 8, n & 0xff]);
  const b = Buffer.alloc(5);
  b[0] = (major << 5) | 26;
  b.writeUInt32BE(n, 1);
  return b;
}

function cbor(v: Cbor): Buffer {
  if (typeof v === "number") return v >= 0 ? head(0, v) : head(1, -1 - v);
  if (typeof v === "string") {
    const b = Buffer.from(v, "utf8");
    return Buffer.concat([head(3, b.length), b]);
  }
  if (v instanceof Uint8Array) return Buffer.concat([head(2, v.length), Buffer.from(v)]);
  if (Array.isArray(v)) return Buffer.concat([head(4, v.length), ...v.map(cbor)]);
  const entries = v instanceof Map ? [...v.entries()] : Object.entries(v);
  return Buffer.concat([head(5, entries.length), ...entries.flatMap(([k, val]) => [cbor(k), cbor(val)])]);
}

const b64u = (b: Uint8Array) => Buffer.from(b).toString("base64url");
const sha256 = (b: Uint8Array | string) => createHash("sha256").update(b).digest();

export class SoftPasskey {
  readonly credentialId = randomBytes(16);
  private readonly privateKey: KeyObject;
  private readonly publicJwk: { x: string; y: string };
  private counter = 0;

  constructor(private readonly origin: string, private readonly rpId: string) {
    const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
    this.privateKey = privateKey;
    this.publicJwk = publicKey.export({ format: "jwk" }) as { x: string; y: string };
  }

  get id() {
    return b64u(this.credentialId);
  }

  private clientData(type: string, challenge: string) {
    return Buffer.from(JSON.stringify({ type, challenge, origin: this.origin, crossOrigin: false }));
  }

  /** Answer navigator.credentials.create() options. */
  register(options: { challenge: string }) {
    const coseKey = new Map<Cbor, Cbor>([
      [1, 2], // kty: EC2
      [3, -7], // alg: ES256
      [-1, 1], // crv: P-256
      [-2, Buffer.from(this.publicJwk.x, "base64url")],
      [-3, Buffer.from(this.publicJwk.y, "base64url")],
    ]);
    const credIdLen = Buffer.alloc(2);
    credIdLen.writeUInt16BE(this.credentialId.length);
    const authData = Buffer.concat([
      sha256(this.rpId),
      Buffer.from([0x45]), // user present + user verified + attested credential data
      Buffer.alloc(4), // sign count 0
      Buffer.alloc(16), // aaguid
      credIdLen,
      this.credentialId,
      cbor(coseKey),
    ]);
    return {
      id: this.id,
      rawId: this.id,
      type: "public-key" as const,
      clientExtensionResults: {},
      response: {
        clientDataJSON: b64u(this.clientData("webauthn.create", options.challenge)),
        attestationObject: b64u(cbor({ fmt: "none", attStmt: {}, authData })),
        transports: ["internal" as const],
      },
    };
  }

  /** Answer navigator.credentials.get() options. `tamper` signs a different challenge than it claims. */
  sign(options: { challenge: string }, opts: { tamper?: boolean } = {}) {
    this.counter++;
    const count = Buffer.alloc(4);
    count.writeUInt32BE(this.counter);
    const authData = Buffer.concat([sha256(this.rpId), Buffer.from([0x05]), count]);
    const clientDataJSON = this.clientData("webauthn.get", options.challenge);
    const signed = opts.tamper ? this.clientData("webauthn.get", "something-else") : clientDataJSON;
    const signature = sign("sha256", Buffer.concat([authData, sha256(signed)]), this.privateKey);
    return {
      id: this.id,
      rawId: this.id,
      type: "public-key" as const,
      clientExtensionResults: {},
      response: {
        clientDataJSON: b64u(clientDataJSON),
        authenticatorData: b64u(authData),
        signature: b64u(signature),
      },
    };
  }
}
