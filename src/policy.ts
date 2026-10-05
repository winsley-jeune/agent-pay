// SPDX-License-Identifier: MIT
import { AppError } from "./errors.js";

// Things agents must never buy or pay for through AgentPay, and websites they
// must never act on, whatever the owner says. Matching is by words in the
// product, tool or plan name and description, and by the website's name, so
// it is a safety net, not a perfect classifier: the agent is also told to
// refuse these on its own and, when in doubt, not to buy.

export const RESTRICTED = ["adult", "medical", "weapons", "drugs", "alcohol", "tobacco", "gambling", "cash_like"] as const;
export type RestrictedCategory = (typeof RESTRICTED)[number];

export const CATEGORY_LABELS: Record<RestrictedCategory, string> = {
  adult: "Pornography and adult content",
  medical: "Medicines (prescription and over the counter), pharmacies and medical devices",
  weapons: "Firearms, ammunition and weapons",
  drugs: "Controlled or illegal drugs",
  alcohol: "Alcohol",
  tobacco: "Tobacco, nicotine and vaping",
  gambling: "Gambling and lotteries",
  cash_like: "Gift cards, prepaid cards, crypto and money transfers (how most scams take money)",
};

const TERMS: Record<RestrictedCategory, string[]> = {
  adult: [
    "porn", "porno", "pornography", "pornographic", "xxx", "nsfw", "hentai", "erotic", "erotica", "onlyfans", "escort", "escorts",
    "sex toy", "sex toys", "adult toy", "adult toys", "adult video", "adult videos", "adult content", "adult entertainment", "vibrator", "dildo", "fetish", "camgirl",
  ],
  medical: [
    "medicine", "medicines", "medication", "medications", "prescription", "prescriptions", "rx", "pharmacy", "pharmacies", "pharmaceutical", "pharmaceuticals",
    "drugstore", "antibiotic", "antibiotics", "amoxicillin", "ibuprofen", "acetaminophen", "paracetamol", "naproxen", "aspirin", "tylenol", "advil", "motrin",
    "aleve", "benadryl", "claritin", "zyrtec", "nyquil", "dayquil", "antihistamine", "cough syrup", "decongestant", "painkiller", "painkillers", "pain reliever",
    "insulin", "inhaler", "epipen", "ozempic", "wegovy", "mounjaro", "semaglutide", "tirzepatide", "viagra", "cialis", "sildenafil", "metformin",
    "mucinex", "pepto-bismol", "pepto bismol", "tums", "pepcid", "imodium", "dramamine", "sudafed", "robitussin", "midol", "excedrin",
    "cold and flu", "cold & flu", "allergy relief", "pain relief", "sleep aid", "antacid", "laxative", "first aid kit",
    "syringe", "syringes", "glucose meter", "test strips", "blood pressure monitor", "hearing aid", "hearing aids", "covid test", "pregnancy test",
  ],
  weapons: [
    "gun", "guns", "firearm", "firearms", "handgun", "handguns", "pistol", "pistols", "rifle", "rifles", "shotgun", "shotguns", "revolver", "revolvers",
    "ammo", "ammunition", "bullets", "gunpowder", "glock", "ar-15", "ar15", "suppressor", "silencer", "gun parts", "receiver kit", "taser", "stun gun",
    "brass knuckles", "switchblade", "crossbow", "explosive", "explosives", "grenade", "grenades", "weapon", "weapons",
  ],
  drugs: [
    "cocaine", "heroin", "meth", "methamphetamine", "fentanyl", "mdma", "ecstasy", "lsd", "psilocybin", "magic mushrooms", "shrooms", "ketamine", "pcp",
    "cannabis", "marijuana", "thc", "delta-8", "delta 8", "kratom", "oxycodone", "hydrocodone", "codeine", "opioid", "opioids", "xanax", "adderall",
    "steroids", "anabolic", "drugs",
  ],
  alcohol: [
    "alcohol", "alcoholic", "beer", "beers", "wine", "wines", "vodka", "whiskey", "whisky", "bourbon", "scotch", "tequila", "mezcal", "rum", "gin",
    "liquor", "champagne", "prosecco", "sake", "hard seltzer", "hard cider", "ipa", "lager", "ale", "cognac", "brandy", "spirits", "seltzer vodka",
  ],
  tobacco: ["tobacco", "cigarette", "cigarettes", "cigar", "cigars", "vape", "vapes", "vaping", "e-cigarette", "juul", "nicotine", "hookah", "rolling papers"],
  gambling: ["casino", "gambling", "betting", "sportsbook", "sports betting", "lottery", "lotto", "slot machine", "slot machines", "draftkings", "fanduel"],
  cash_like: [
    "gift card", "gift cards", "giftcard", "giftcards", "e-gift card", "egift card", "prepaid card", "prepaid cards", "prepaid debit card",
    "reload card", "reloadable card", "vanilla visa", "vanilla mastercard", "itunes card", "apple gift card", "google play card", "steam card",
    "bitcoin", "buy crypto", "cryptocurrency", "bitcoin atm",
    "western union", "moneygram", "wire transfer", "money order", "money orders", "money transfer", "zelle", "venmo", "cash app",
  ],
};

// Everyday things that contain a restricted word but aren't restricted.
const NOT_RESTRICTED = [
  "root beer", "ginger beer", "ginger ale", "wine vinegar", "rice wine vinegar", "non-alcoholic", "non alcoholic", "alcohol-free", "alcohol free",
  "glue gun", "nail gun", "staple gun", "heat gun", "water gun", "squirt gun", "spray gun", "caulk gun", "massage gun", "gunmetal", "gun metal",
  "rum extract", "drug-free", "drug free",
];

// Websites agents may never be given permission to act on.
const SITES: Partial<Record<RestrictedCategory, string[]>> = {
  medical: [
    "cvs.com", "walgreens.com", "riteaid.com", "pharmacy.amazon.com", "goodrx.com", "capsule.com", "alto.com", "hims.com", "forhers.com", "ro.co",
    "nurx.com", "blinkhealth.com", "costplusdrugs.com", "express-scripts.com", "optumrx.com", "caremark.com", "healthwarehouse.com", "1800contacts.com",
  ],
  alcohol: ["drizly.com", "totalwine.com", "reservebar.com", "wine.com", "minibardelivery.com", "saucey.com", "flaviar.com", "winc.com", "bevmo.com", "liquor.com"],
  weapons: ["gunbroker.com", "budsgunshop.com", "palmettostatearmory.com", "cheaperthandirt.com", "sportsmans.com", "ammo.com", "luckygunner.com", "guns.com"],
  adult: ["pornhub.com", "xvideos.com", "onlyfans.com", "fansly.com", "chaturbate.com", "adultempire.com"],
  tobacco: ["juul.com", "vapewild.com", "element-vape.com", "smokecartel.com"],
  gambling: ["draftkings.com", "fanduel.com", "betmgm.com", "caesars.com", "pokerstars.com", "bet365.com"],
  cash_like: [
    "coinbase.com", "binance.com", "binance.us", "kraken.com", "crypto.com", "gemini.com", "westernunion.com", "moneygram.com", "remitly.com",
    "giftcards.com", "raise.com", "cardcash.com", "giftcardgranny.com", "venmo.com", "cash.app", "paypal.me",
  ],
};
// Words in a site's name that put it in a category ("bestrxpharmacy.com", "joesliquor.com").
const SITE_WORDS: Partial<Record<RestrictedCategory, string[]>> = {
  medical: ["pharmacy", "pharma", "drugstore", "apotheke"],
  alcohol: ["liquor", "winery", "brewery", "wineshop"],
  weapons: ["gunshop", "firearms", "armory"],
  adult: ["porn", "xxx"],
  tobacco: ["vape", "tobacco", "smokeshop"],
  gambling: ["casino", "betting", "sportsbook", "lottery"],
  cash_like: ["giftcard", "bitcoin", "crypto"],
};

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const PATTERNS = Object.fromEntries(
  RESTRICTED.map((c) => [c, new RegExp(`(?<![a-z0-9])(${TERMS[c].map(escape).join("|")})(?![a-z0-9])`, "i")]),
) as Record<RestrictedCategory, RegExp>;

export interface Refusal {
  category: RestrictedCategory;
  label: string;
  matched: string;
}

/** The first restricted category the text falls in, or null. */
export function screen(text: string | null | undefined): Refusal | null {
  if (!text) return null;
  let t = ` ${text.toLowerCase().replace(/[_/]+/g, " ")} `;
  for (const ok of NOT_RESTRICTED) t = t.split(ok).join(" ");
  for (const category of RESTRICTED) {
    const m = t.match(PATTERNS[category]);
    if (m) return { category, label: CATEGORY_LABELS[category], matched: m[1] };
  }
  return null;
}

/** Whether a website (host name such as "walgreens.com") is one agents may never act on. */
export function screenSite(host: string): Refusal | null {
  const h = host.toLowerCase();
  for (const category of RESTRICTED) {
    const listed = SITES[category]?.find((s) => h === s || h.endsWith(`.${s}`));
    if (listed) return { category, label: CATEGORY_LABELS[category], matched: listed };
    const word = SITE_WORDS[category]?.find((w) => h.split(".").slice(0, -1).some((label) => label.includes(w)));
    if (word) return { category, label: CATEGORY_LABELS[category], matched: h };
  }
  return null;
}

export function refusalMessage(r: Refusal): string {
  return `Refused: "${r.matched}" falls under ${r.label.toLowerCase()}. Agents can't buy, pay for or act on these through AgentPay, even if the owner asks; the owner has to do it themselves.`;
}

export function refusalError(r: Refusal) {
  return new AppError(403, "restricted_category", refusalMessage(r), { category: r.category, matched: r.matched });
}

/** Throw if the text is restricted. */
export function enforce(...texts: (string | null | undefined)[]) {
  for (const t of texts) {
    const r = screen(t);
    if (r) throw refusalError(r);
  }
}

export function enforceSite(host: string) {
  const r = screenSite(host);
  if (r) throw refusalError(r);
}

export function policySummary() {
  return {
    refused: RESTRICTED.map((c) => ({ category: c, label: CATEGORY_LABELS[c] })),
    note:
      "Agents never buy, pay for or act on websites in these categories, and the owner can't turn this off. " +
      "Matching by words and site names can miss things, so when in doubt the agent doesn't buy and asks the owner.",
  };
}
