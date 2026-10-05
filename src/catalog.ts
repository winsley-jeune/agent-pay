import type { Db } from "./db.js";

// Reference data for everyday subscriptions. Tier prices are approximate US
// list prices as of PRICES_AS_OF and are used only to suggest savings; the
// price the owner actually pays is always what's stored on their subscription.
// Update this file (or the services table) as prices change.

export const PRICES_AS_OF = "2025-10-01";

type Interval = "week" | "month" | "year";
interface Tier {
  name: string;
  priceCents: number;
  interval: Interval;
  ads?: boolean;
}
export interface Service {
  slug: string;
  name: string;
  category: string;
  website?: string;
  cancelUrl?: string;
  cancelSteps?: string[];
  merchantPatterns: string[];
  contractRisk?: boolean;
  contractNote?: string;
  tiers?: Tier[];
}
export interface Bundle {
  slug: string;
  name: string;
  includes: string[];
  priceCents: number;
  interval: Interval;
  note?: string;
}

export const SERVICES: Service[] = [
  {
    slug: "netflix", name: "Netflix", category: "streaming", website: "https://www.netflix.com",
    cancelUrl: "https://www.netflix.com/cancelplan",
    cancelSteps: ["Sign in at netflix.com", "Account → Cancel membership", "Confirm; you keep access until the end of the billing period"],
    merchantPatterns: ["NETFLIX"],
    tiers: [
      { name: "Standard with ads", priceCents: 799, interval: "month", ads: true },
      { name: "Standard", priceCents: 1799, interval: "month" },
      { name: "Premium", priceCents: 2499, interval: "month" },
    ],
  },
  {
    slug: "apple-tv", name: "Apple TV+", category: "streaming", website: "https://tv.apple.com",
    merchantPatterns: [], // billed as APPLE.COM/BILL together with other Apple subscriptions
    tiers: [{ name: "Monthly", priceCents: 1299, interval: "month" }],
  },
  {
    slug: "paramount-plus", name: "Paramount+", category: "streaming", website: "https://www.paramountplus.com",
    cancelUrl: "https://www.paramountplus.com/account/",
    cancelSteps: ["Sign in at paramountplus.com", "Account → Cancel subscription", "If you subscribed through Apple, Google, Amazon or Roku, cancel there instead"],
    merchantPatterns: ["PARAMOUNT"],
    tiers: [
      { name: "Essential (ads)", priceCents: 799, interval: "month", ads: true },
      { name: "Premium", priceCents: 1299, interval: "month" },
      { name: "Premium annual", priceCents: 11999, interval: "year" },
    ],
  },
  {
    slug: "disney-plus", name: "Disney+", category: "streaming", website: "https://www.disneyplus.com",
    cancelUrl: "https://www.disneyplus.com/account",
    cancelSteps: ["Sign in at disneyplus.com", "Account → Subscription → Cancel subscription"],
    merchantPatterns: ["DISNEY PLUS", "DISNEYPLUS", "DISNEY+"],
    tiers: [
      { name: "Basic (ads)", priceCents: 1199, interval: "month", ads: true },
      { name: "Premium", priceCents: 1899, interval: "month" },
    ],
  },
  {
    slug: "hulu", name: "Hulu", category: "streaming", website: "https://www.hulu.com",
    cancelUrl: "https://secure.hulu.com/account",
    cancelSteps: ["Sign in at hulu.com", "Account → Cancel your subscription"],
    merchantPatterns: ["HULU"],
    tiers: [
      { name: "With ads", priceCents: 1199, interval: "month", ads: true },
      { name: "No ads", priceCents: 1899, interval: "month" },
    ],
  },
  {
    slug: "hbo-max", name: "HBO Max", category: "streaming", website: "https://www.hbomax.com",
    cancelSteps: ["Sign in at hbomax.com", "Profile → Settings → Subscription → Manage → Cancel"],
    merchantPatterns: ["HBO MAX", "HBOMAX", "MAX.COM", "WARNER BROS"],
    tiers: [
      { name: "Basic with ads", priceCents: 1099, interval: "month", ads: true },
      { name: "Standard", priceCents: 1849, interval: "month" },
      { name: "Premium", priceCents: 2299, interval: "month" },
    ],
  },
  {
    slug: "peacock", name: "Peacock", category: "streaming", website: "https://www.peacocktv.com",
    cancelUrl: "https://www.peacocktv.com/account",
    cancelSteps: ["Sign in at peacocktv.com", "Account → Plans & Payment → Change plan → Cancel"],
    merchantPatterns: ["PEACOCK"],
    tiers: [
      { name: "Premium (ads)", priceCents: 1099, interval: "month", ads: true },
      { name: "Premium Plus", priceCents: 1699, interval: "month" },
    ],
  },
  {
    slug: "youtube-premium", name: "YouTube Premium", category: "streaming", website: "https://www.youtube.com",
    cancelUrl: "https://www.youtube.com/paid_memberships",
    cancelSteps: ["Go to youtube.com/paid_memberships", "Manage membership → Deactivate"],
    merchantPatterns: ["YOUTUBE", "GOOGLE *YOUTUBE"],
    tiers: [{ name: "Individual", priceCents: 1399, interval: "month" }],
  },
  {
    slug: "spotify", name: "Spotify Premium", category: "music", website: "https://www.spotify.com",
    cancelUrl: "https://www.spotify.com/account/subscription/",
    cancelSteps: ["Sign in at spotify.com/account", "Manage your plan → Cancel Premium"],
    merchantPatterns: ["SPOTIFY"],
    tiers: [{ name: "Individual", priceCents: 1199, interval: "month" }],
  },
  {
    slug: "apple-music", name: "Apple Music", category: "music", website: "https://music.apple.com",
    merchantPatterns: [],
    tiers: [{ name: "Individual", priceCents: 1099, interval: "month" }],
  },
  {
    slug: "icloud", name: "iCloud+", category: "cloud storage", website: "https://www.icloud.com",
    merchantPatterns: [],
    tiers: [{ name: "200 GB", priceCents: 299, interval: "month" }],
  },
  {
    slug: "amazon-prime", name: "Amazon Prime", category: "shopping", website: "https://www.amazon.com",
    cancelUrl: "https://www.amazon.com/mc",
    cancelSteps: ["Go to amazon.com → Account → Prime membership", "Manage membership → End membership", "Amazon shows several 'are you sure' pages; keep going"],
    merchantPatterns: ["AMAZON PRIME", "PRIME VIDEO", "AMZN PRIME"],
    tiers: [
      { name: "Monthly", priceCents: 1499, interval: "month" },
      { name: "Annual", priceCents: 13900, interval: "year" },
    ],
  },
  {
    slug: "att-wireless", name: "AT&T Wireless", category: "phone", website: "https://www.att.com",
    cancelSteps: [
      "Check for a device installment balance or contract end date in the myAT&T app first",
      "Call AT&T at 800-331-0500, or port your number to a new carrier (porting cancels the line)",
      "Keep the confirmation number",
    ],
    merchantPatterns: ["AT&T", "ATT*", "ATT BILL", "AT T "],
    contractRisk: true,
    contractNote: "Cancelling a line with a device installment plan makes the remaining device balance due. Not paying the bill does not cancel it.",
  },
  {
    slug: "verizon", name: "Verizon", category: "phone", website: "https://www.verizon.com",
    cancelSteps: ["Check for a device payment balance in My Verizon", "Call 800-922-0204 or port your number to a new carrier"],
    merchantPatterns: ["VERIZON", "VZWRLSS"],
    contractRisk: true,
    contractNote: "Any remaining device payment balance becomes due when you cancel.",
  },
  {
    slug: "t-mobile", name: "T-Mobile", category: "phone", website: "https://www.t-mobile.com",
    cancelSteps: ["Check for a device balance in the T-Life app", "Call 611 from your phone or port your number"],
    merchantPatterns: ["T-MOBILE", "TMOBILE"],
    contractRisk: true,
    contractNote: "Remaining device payments become due when you cancel.",
  },
  {
    slug: "planet-fitness", name: "Planet Fitness", category: "fitness", website: "https://www.planetfitness.com",
    cancelSteps: [
      "Read your membership agreement for notice periods and annual fees",
      "Cancel at your home club in person, or by the method your club accepts (some allow online, others want a letter)",
      "Get written confirmation",
    ],
    merchantPatterns: ["PLANET FITNESS", "PF CLUB", "PLANETFIT"],
    contractRisk: true,
    contractNote: "Gyms often require notice, charge an annual fee, or need in-person or written cancellation. Blocking the card does not end the contract.",
    tiers: [
      { name: "Classic", priceCents: 1500, interval: "month" },
      { name: "Black Card", priceCents: 2999, interval: "month" },
    ],
  },
  {
    slug: "gym", name: "Gym membership", category: "fitness",
    cancelSteps: ["Read your membership agreement for the notice period and cancellation method", "Cancel in writing and keep proof"],
    merchantPatterns: ["FITNESS", "GYM", "24 HOUR FIT", "LA FITNESS", "EQUINOX", "CRUNCH FIT", "ANYTIME FIT"],
    contractRisk: true,
    contractNote: "Gym contracts often require notice or written cancellation and may charge a cancellation fee.",
  },
  {
    slug: "microsoft-365", name: "Microsoft 365", category: "software", website: "https://www.microsoft.com",
    cancelUrl: "https://account.microsoft.com/services",
    cancelSteps: ["Sign in at account.microsoft.com/services", "Manage → Cancel subscription"],
    merchantPatterns: ["MICROSOFT*", "MSFT *"],
    tiers: [
      { name: "Personal monthly", priceCents: 999, interval: "month" },
      { name: "Personal annual", priceCents: 9999, interval: "year" },
    ],
  },
  {
    slug: "adobe", name: "Adobe Creative Cloud", category: "software", website: "https://www.adobe.com",
    cancelUrl: "https://account.adobe.com/plans",
    cancelSteps: ["Sign in at account.adobe.com/plans", "Manage plan → Cancel plan"],
    merchantPatterns: ["ADOBE"],
    contractRisk: true,
    contractNote: "Annual plans paid monthly charge an early cancellation fee after the first 14 days.",
  },
];

export const BUNDLES: Bundle[] = [
  { slug: "apple-one-individual", name: "Apple One Individual", includes: ["apple-tv", "apple-music", "icloud"], priceCents: 1995, interval: "month", note: "Also includes Apple Arcade; 50 GB iCloud+" },
  { slug: "disney-hulu-max", name: "Disney+, Hulu, HBO Max bundle (ads)", includes: ["disney-plus", "hulu", "hbo-max"], priceCents: 1999, interval: "month" },
  { slug: "disney-hulu", name: "Disney+ and Hulu bundle (ads)", includes: ["disney-plus", "hulu"], priceCents: 1299, interval: "month" },
];

export async function syncCatalog(db: Db) {
  for (const s of SERVICES) {
    await db.query(
      `INSERT INTO services (slug, name, category, website, cancel_url, cancel_steps, merchant_patterns, contract_risk, contract_note, tiers, prices_as_of)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name, category = EXCLUDED.category, website = EXCLUDED.website,
         cancel_url = EXCLUDED.cancel_url, cancel_steps = EXCLUDED.cancel_steps, merchant_patterns = EXCLUDED.merchant_patterns,
         contract_risk = EXCLUDED.contract_risk, contract_note = EXCLUDED.contract_note, tiers = EXCLUDED.tiers, prices_as_of = EXCLUDED.prices_as_of`,
      [s.slug, s.name, s.category, s.website ?? null, s.cancelUrl ?? null, s.cancelSteps ?? [], s.merchantPatterns, s.contractRisk ?? false, s.contractNote ?? null, JSON.stringify(s.tiers ?? []), PRICES_AS_OF],
    );
  }
  for (const b of BUNDLES) {
    await db.query(
      `INSERT INTO service_bundles (slug, name, includes, price_cents, interval, note, prices_as_of) VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name, includes = EXCLUDED.includes, price_cents = EXCLUDED.price_cents,
         interval = EXCLUDED.interval, note = EXCLUDED.note, prices_as_of = EXCLUDED.prices_as_of`,
      [b.slug, b.name, b.includes, b.priceCents, b.interval, b.note ?? null, PRICES_AS_OF],
    );
  }
}

export function serviceBySlug(slug: string): Service | undefined {
  return SERVICES.find((s) => s.slug === slug);
}

/** Apple, Google and Amazon bill many subscriptions under one merchant name. */
export const STORE_BILLERS: { pattern: string; billedThrough: "apple" | "google" | "amazon"; label: string }[] = [
  { pattern: "APPLE.COM/BILL", billedThrough: "apple", label: "Apple subscriptions" },
  { pattern: "GOOGLE *", billedThrough: "google", label: "Google Play subscriptions" },
  { pattern: "AMAZON DIGITAL", billedThrough: "amazon", label: "Amazon subscriptions" },
];
