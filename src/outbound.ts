import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { AppError } from "./errors.js";
import { refusalError, screen, screenSite } from "./policy.js";
import { normalizeSite } from "./permissions.js";

// Requests the server makes to addresses an agent chose (x402 resources, A2A
// agents). Agents must never be able to make AgentPay reach its own network:
// only https, no private, loopback, link-local or metadata addresses (checked
// on every DNS answer and every redirect), a size cap and a timeout.

export interface OutboundOptions {
  fetchImpl?: typeof fetch;
  /** Resolves a host name to its addresses; injectable for tests. */
  resolve?: (host: string) => Promise<string[]>;
  /** Allow http:// to localhost (development only). */
  allowLocalHttp?: boolean;
}

const MAX_BYTES = 1_000_000;
const MAX_REDIRECTS = 3;
const TIMEOUT_MS = 30_000;

function privateAddress(ip: string): boolean {
  if (isIP(ip) === 6) {
    const v = ip.toLowerCase();
    if (v === "::1" || v === "::") return true;
    if (v.startsWith("fc") || v.startsWith("fd") || v.startsWith("fe8") || v.startsWith("fe9") || v.startsWith("fea") || v.startsWith("feb")) return true;
    const mapped = v.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    return mapped ? privateAddress(mapped[1]) : false;
  }
  const [a, b] = ip.split(".").map(Number);
  return (
    a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) || (a === 198 && (b === 18 || b === 19)) || a >= 224
  );
}

const defaultResolve = async (host: string) => (await lookup(host, { all: true })).map((r) => r.address);

/** Throw unless the URL is a public https address that isn't in a restricted category. */
export async function assertPublicUrl(raw: string, opts: OutboundOptions = {}): Promise<URL> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new AppError(400, "invalid_url", "give a full https:// address");
  }
  const host = url.hostname.replace(/^\[|\]$/g, "");
  const local = host === "localhost" || host === "127.0.0.1";
  if (url.protocol !== "https:" && !(opts.allowLocalHttp && local && url.protocol === "http:")) {
    throw new AppError(400, "https_only", "only https:// addresses can be paid");
  }
  if (url.username || url.password) throw new AppError(400, "invalid_url", "addresses with a user name or password aren't allowed");
  if (!(opts.allowLocalHttp && local)) {
    const addresses = isIP(host) ? [host] : await (opts.resolve ?? defaultResolve)(host).catch(() => [] as string[]);
    if (!addresses.length) throw new AppError(400, "unresolvable", `can't find ${host}`);
    if (addresses.some(privateAddress)) throw new AppError(400, "private_address", "that address is on a private or internal network");
  }
  const site = screenSite(normalizeSite(url.hostname));
  if (site) throw refusalError(site);
  const text = screen(url.pathname.replace(/[-_/]+/g, " "));
  if (text) throw refusalError(text);
  return url;
}

export interface OutboundResponse {
  status: number;
  headers: Headers;
  text: string;
  json: unknown;
  url: string;
}

/** fetch() with the checks above on the first address and every redirect, a 1 MB cap and a 30 s timeout. */
export async function safeFetch(raw: string, init: RequestInit, opts: OutboundOptions = {}): Promise<OutboundResponse> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  let current = (await assertPublicUrl(raw, opts)).toString();
  for (let hop = 0; ; hop++) {
    const res = await fetchImpl(current, { ...init, redirect: "manual", signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (res.status >= 300 && res.status < 400 && res.headers.get("location")) {
      if (hop >= MAX_REDIRECTS) throw new AppError(502, "too_many_redirects", "the address redirected too many times");
      current = (await assertPublicUrl(new URL(res.headers.get("location")!, current).toString(), opts)).toString();
      continue;
    }
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > MAX_BYTES) throw new AppError(502, "response_too_large", "the response is larger than 1 MB");
    const text = buf.toString("utf8");
    let json: unknown = null;
    try {
      json = JSON.parse(text);
    } catch {
      // not JSON
    }
    return { status: res.status, headers: res.headers, text, json, url: current };
  }
}
