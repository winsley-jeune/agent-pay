import { randomBytes } from "node:crypto";
import { privateKeyToAccount } from "viem/accounts";
import { config } from "./config.js";
import { AppError } from "./errors.js";

// x402 (https://github.com/coinbase/x402): a seller answers HTTP 402 with what
// it accepts; the buyer signs an EIP-3009 USDC transferWithAuthorization and
// retries; the seller settles it on-chain. AgentPay signs with its own wallet
// (X402_PRIVATE_KEY) on the owner's behalf, after the owner's limits and
// approvals, and charges the owner's prepaid credits.
//
// Both protocol versions are supported:
//   v1  requirements in the 402 JSON body (network "base", maxAmountRequired); payment in X-PAYMENT
//   v2  requirements in the PAYMENT-REQUIRED header (network "eip155:8453", amount); payment in PAYMENT-SIGNATURE
// Only the "exact" scheme with USDC on Base (or Base Sepolia for testing) is accepted.

export interface Network {
  v1: string;
  v2: string;
  chainId: number;
  usdc: `0x${string}`;
  testnet: boolean;
}

export const NETWORKS: Record<string, Network> = {
  base: { v1: "base", v2: "eip155:8453", chainId: 8453, usdc: "0x833589fCD6eDb6E08f4c7C32D4f71b54bda02913", testnet: false },
  "base-sepolia": { v1: "base-sepolia", v2: "eip155:84532", chainId: 84532, usdc: "0x036CbD53842c5426634e7929541eC2318f3dCF7e", testnet: true },
};

export function configuredNetwork(): Network {
  const n = NETWORKS[config.x402Network];
  if (!n) throw new AppError(503, "x402_not_configured", `X402_NETWORK must be one of ${Object.keys(NETWORKS).join(", ")}`);
  return n;
}

export interface Requirement {
  scheme: string;
  network: string;
  amountAtomic: bigint;
  asset: string;
  payTo: string;
  maxTimeoutSeconds: number;
  extra: { name?: string; version?: string } & Record<string, unknown>;
  description: string | null;
  resource: unknown;
  raw: Record<string, unknown>;
}

export interface PaymentRequired {
  version: 1 | 2;
  accepts: Requirement[];
  resource: unknown;
  error: string | null;
}

function toRequirement(a: any, version: 1 | 2, resource: unknown): Requirement | null {
  const amount = version === 1 ? a?.maxAmountRequired : a?.amount ?? a?.maxAmountRequired;
  if (typeof a?.scheme !== "string" || typeof a?.network !== "string" || typeof a?.asset !== "string" || typeof a?.payTo !== "string") return null;
  if (typeof amount !== "string" && typeof amount !== "number") return null;
  if (!/^\d+$/.test(String(amount))) return null;
  return {
    scheme: a.scheme, network: a.network, amountAtomic: BigInt(String(amount)), asset: a.asset, payTo: a.payTo,
    maxTimeoutSeconds: Number.isInteger(a.maxTimeoutSeconds) ? a.maxTimeoutSeconds : 60, extra: a.extra ?? {},
    description: typeof a.description === "string" ? a.description : typeof (resource as any)?.description === "string" ? (resource as any).description : null,
    resource: a.resource ?? resource ?? null, raw: a,
  };
}

/** Parse what a seller accepts, from a v2 PAYMENT-REQUIRED header, a v1 402 body, or A2A metadata. */
export function parsePaymentRequired(source: { header?: string | null; body?: unknown }): PaymentRequired | null {
  let obj: any = null;
  if (source.header) {
    try {
      obj = JSON.parse(Buffer.from(source.header, "base64").toString("utf8"));
    } catch {
      return null;
    }
  } else if (source.body && typeof source.body === "object") {
    obj = source.body;
  }
  if (!obj || !Array.isArray(obj.accepts)) return null;
  const version: 1 | 2 = obj.x402Version === 2 ? 2 : 1;
  const accepts = obj.accepts.map((a: unknown) => toRequirement(a, version, obj.resource)).filter(Boolean) as Requirement[];
  return { version, accepts, resource: obj.resource ?? null, error: typeof obj.error === "string" ? obj.error : null };
}

/** The requirement AgentPay can pay: exact scheme, USDC, on the configured network. */
export function pickRequirement(pr: PaymentRequired, network = configuredNetwork()): Requirement {
  const ok = pr.accepts.find(
    (a) => a.scheme === "exact" && (a.network === network.v1 || a.network === network.v2) && a.asset.toLowerCase() === network.usdc.toLowerCase(),
  );
  if (!ok) {
    const offered = pr.accepts.map((a) => `${a.scheme}/${a.network}`).join(", ") || "nothing";
    throw new AppError(402, "x402_unsupported", `the seller accepts ${offered}; AgentPay pays only USDC with the exact scheme on ${network.v1}`);
  }
  return ok;
}

/** USDC has 6 decimals: 1 cent = 10,000 atomic units. Rounds up so the owner is never charged less than is paid. */
export function atomicToCents(atomic: bigint): number {
  const cents = (atomic + 9_999n) / 10_000n;
  if (cents > BigInt(Number.MAX_SAFE_INTEGER)) throw new AppError(402, "x402_amount", "amount too large");
  return Number(cents);
}

export function payerAddress(): `0x${string}` {
  if (!config.x402PrivateKey) throw new AppError(503, "x402_not_configured", "paying x402 sellers isn't set up on this server (X402_PRIVATE_KEY)");
  return privateKeyToAccount(config.x402PrivateKey as `0x${string}`).address;
}

/** Sign the EIP-3009 authorization and build the payment payload for this version. */
export async function signPayment(req: Requirement, version: 1 | 2, network = configuredNetwork()) {
  if (!config.x402PrivateKey) throw new AppError(503, "x402_not_configured", "paying x402 sellers isn't set up on this server (X402_PRIVATE_KEY)");
  const account = privateKeyToAccount(config.x402PrivateKey as `0x${string}`);
  const now = Math.floor(Date.now() / 1000);
  const authorization = {
    from: account.address,
    to: req.payTo as `0x${string}`,
    value: req.amountAtomic,
    validAfter: BigInt(now - 60),
    validBefore: BigInt(now + Math.min(Math.max(req.maxTimeoutSeconds, 30), 3600)),
    nonce: `0x${randomBytes(32).toString("hex")}` as `0x${string}`,
  };
  const signature = await account.signTypedData({
    domain: { name: String(req.extra.name ?? "USD Coin"), version: String(req.extra.version ?? "2"), chainId: network.chainId, verifyingContract: network.usdc },
    types: {
      TransferWithAuthorization: [
        { name: "from", type: "address" },
        { name: "to", type: "address" },
        { name: "value", type: "uint256" },
        { name: "validAfter", type: "uint256" },
        { name: "validBefore", type: "uint256" },
        { name: "nonce", type: "bytes32" },
      ],
    },
    primaryType: "TransferWithAuthorization",
    message: authorization,
  });
  const auth = {
    from: authorization.from, to: authorization.to, value: authorization.value.toString(),
    validAfter: authorization.validAfter.toString(), validBefore: authorization.validBefore.toString(), nonce: authorization.nonce,
  };
  const payload =
    version === 2
      ? { x402Version: 2, resource: req.resource, accepted: req.raw, payload: { signature, authorization: auth } }
      : { x402Version: 1, scheme: req.scheme, network: req.network, payload: { signature, authorization: auth } };
  return { payload, header: Buffer.from(JSON.stringify(payload)).toString("base64"), authorization: auth, signature };
}

/** The seller's settlement response (PAYMENT-RESPONSE / X-PAYMENT-RESPONSE), if any. */
export function parseSettlement(header: string | null): { success: boolean; transaction?: string; network?: string; payer?: string; errorReason?: string } | null {
  if (!header) return null;
  try {
    return JSON.parse(Buffer.from(header, "base64").toString("utf8"));
  } catch {
    return null;
  }
}
