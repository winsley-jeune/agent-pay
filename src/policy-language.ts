import type { AgentKey, AgentKeyLimits } from "./auth.js";
import type { Db } from "./db.js";
import type { Level, SpendRule } from "./controls.js";

// Plain-English spending rules ("under $5 go through on their own, over $50
// ask me, $200 a day, never more than $100 a payment") turned into the agent
// key's level, rules and limits, with a dry run against the agent's last 30
// days (idea from askgrokwallet; docs/landscape.md). Parsing is deterministic:
// no AI model decides what the owner meant. Anything not understood is listed,
// and nothing is applied until the owner confirms.

export interface ParsedPolicy {
  limits: Required<Pick<AgentKeyLimits, "level" | "spendRules" | "observeAboveCents" | "approvalThresholdCents" | "perCallMaxCents" | "dailyCapCents" | "monthlyCapCents" | "allowedToolSlugs">>;
  understood: { clause: string; meaning: string }[];
  notUnderstood: string[];
}

const usd = (c: number) => `$${(c / 100).toFixed(2)}`;
const MONEY = String.raw`\$\s*(\d+(?:\.\d{1,2})?)|(\d+(?:\.\d{1,2})?)\s*(dollars?|usd|bucks|cents?|¢)`;

function money(m: RegExpMatchArray, from = 1): number {
  const dollarsSign = m[from];
  const n = m[from + 1];
  const unit = (m[from + 2] ?? "").toLowerCase();
  if (dollarsSign !== undefined) return Math.round(Number(dollarsSign) * 100);
  return unit.startsWith("cent") || unit === "¢" ? Math.round(Number(n)) : Math.round(Number(n) * 100);
}

/** Split into clauses on sentence ends, semicolons, new lines, and ", and" / ", but". */
function clauses(text: string): string[] {
  return text
    .split(/[.;\n]+|,\s*(?:and|but|then)\s+|\s+and\s+(?=(?:under|below|over|above|never|only|always|flag|review|up to|at most|max|no more|\$))/i)
    .map((s) => s.trim().replace(/^(and|but|then)\s+/i, ""))
    .filter((s) => s.length > 1);
}

export function parsePolicy(text: string, tools: { slug: string; name: string }[] = []): ParsedPolicy {
  const out: ParsedPolicy = {
    limits: { level: "budget", spendRules: [], observeAboveCents: null, approvalThresholdCents: null, perCallMaxCents: null, dailyCapCents: null, monthlyCapCents: null, allowedToolSlugs: null },
    understood: [],
    notUnderstood: [],
  };
  let askAlways = false;
  const findTools = (s: string) =>
    tools.filter((t) => new RegExp(`(?<![a-z0-9-])(${t.slug.replace(/[-]/g, "[- ]")}|${t.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")})(?![a-z0-9-])`, "i").test(s)).map((t) => t.slug);

  for (const c of clauses(text)) {
    const lc = c.toLowerCase();
    let m: RegExpMatchArray | null;
    const add = (meaning: string) => out.understood.push({ clause: c, meaning });

    if (/\b(always ask|ask (me )?(before|for) (every|each|all|any)|ask every time|nothing (goes through|on its own))\b/.test(lc)) {
      askAlways = true;
      add("Ask before every paid call (level L0)");
    } else if ((m = lc.match(new RegExp(String.raw`\b(?:never|don'?t)\s+(?:pay|spend)\s+(?:more than|over|above)\s+(?:${MONEY})`)))) {
      out.limits.perCallMaxCents = money(m);
      add(`Never more than ${usd(out.limits.perCallMaxCents)} for one payment`);
    } else if ((m = lc.match(new RegExp(String.raw`\b(?:at most|max(?:imum)?|no more than|up to)\s+(?:${MONEY})\s+(?:per|a|each|for (?:a|one))\s+(?:call|payment|purchase|task)`)))) {
      out.limits.perCallMaxCents = money(m);
      add(`Never more than ${usd(out.limits.perCallMaxCents)} for one payment`);
    } else if ((m = lc.match(new RegExp(String.raw`(?:${MONEY})\s*(?:a|per|each)?\s*(day|daily)\b|\bdaily (?:budget|limit|cap|max(?:imum)?)\s*(?:of|is|:)?\s*(?:${MONEY})`)))) {
      out.limits.dailyCapCents = m[1] !== undefined || m[2] !== undefined ? money(m) : money(m, 5);
      add(`At most ${usd(out.limits.dailyCapCents)} in any 24 hours`);
    } else if ((m = lc.match(new RegExp(String.raw`(?:${MONEY})\s*(?:a|per|each)?\s*(month|monthly)\b|\bmonthly (?:budget|limit|cap|max(?:imum)?)\s*(?:of|is|:)?\s*(?:${MONEY})`)))) {
      out.limits.monthlyCapCents = m[1] !== undefined || m[2] !== undefined ? money(m) : money(m, 5);
      add(`At most ${usd(out.limits.monthlyCapCents)} in any 30 days`);
    } else if ((m = lc.match(new RegExp(String.raw`\b(?:flag|review|show me|tell me about|let me (?:see|review))\b.*?\b(?:over|above|more than)\s+(?:${MONEY})`)))) {
      out.limits.observeAboveCents = money(m);
      add(`Pay, but flag for review anything over ${usd(out.limits.observeAboveCents)}`);
    } else if ((m = lc.match(new RegExp(String.raw`\b(?:over|above|more than)\s+(?:${MONEY}).*\bask\b|\bask\b.*\b(?:over|above|more than|for anything over)\s+(?:${MONEY})`)))) {
      out.limits.approvalThresholdCents = m[1] !== undefined || m[2] !== undefined ? money(m) : money(m, 4);
      add(`Ask me for anything over ${usd(out.limits.approvalThresholdCents)}`);
    } else if ((m = lc.match(new RegExp(String.raw`\b(?:under|below|less than|up to|at most)\s+(?:${MONEY})`))) && /\b(automatic|on (its|their) own|go(es)? through|without asking|auto|is fine|ok(ay)?|run|pay)\b/.test(lc)) {
      const cents = money(m);
      const only = findTools(c);
      const observe = /\b(flag|review|tell me|let me know)\b/.test(lc);
      out.limits.spendRules.push({ name: c.slice(0, 60), tools: only.length ? only : null, maxCents: cents, outcome: observe ? "observe" : "auto" });
      add(`${only.length ? `For ${only.join(", ")}: ` : ""}pay on its own up to ${usd(cents)}${observe ? ", flagged for review" : ""}`);
    } else if ((m = lc.match(/\bonly (?:use|pay for|call|pay)\s+(.+)/))) {
      const only = findTools(m[1]);
      if (only.length) {
        out.limits.allowedToolSlugs = [...new Set([...(out.limits.allowedToolSlugs ?? []), ...only])];
        add(`Only these tools: ${only.join(", ")}`);
      } else out.notUnderstood.push(c);
    } else {
      out.notUnderstood.push(c);
    }
  }
  out.limits.level = (askAlways ? "ask" : out.limits.spendRules.length ? "rules" : "budget") as Level;
  return out;
}

export type SimOutcome = "auto" | "observe" | "ask" | "blocked";

/** What these limits would have done with each payment, in order (asked-for payments aren't counted toward caps). */
export function simulate(limits: ParsedPolicy["limits"], events: { at: Date; tool: string; amountCents: number }[]) {
  const done: { at: number; cents: number }[] = [];
  return events.map((e) => {
    const t = new Date(e.at).getTime();
    const sumSince = (ms: number) => done.filter((d) => d.at > t - ms).reduce((s, d) => s + d.cents, 0);
    let outcome: SimOutcome;
    let why: string;
    if (limits.allowedToolSlugs && !limits.allowedToolSlugs.includes(e.tool)) [outcome, why] = ["blocked", "tool not allowed"];
    else if (limits.perCallMaxCents !== null && e.amountCents > limits.perCallMaxCents) [outcome, why] = ["blocked", "over the per-payment maximum"];
    else if (limits.dailyCapCents !== null && sumSince(86_400_000) + e.amountCents > limits.dailyCapCents) [outcome, why] = ["blocked", "over the daily limit"];
    else if (limits.monthlyCapCents !== null && sumSince(30 * 86_400_000) + e.amountCents > limits.monthlyCapCents) [outcome, why] = ["blocked", "over the 30-day limit"];
    else if (limits.level === "ask") [outcome, why] = ["ask", "asks before every payment"];
    else if (limits.approvalThresholdCents !== null && e.amountCents > limits.approvalThresholdCents) [outcome, why] = ["ask", "over the approval threshold"];
    else if (limits.level === "rules") {
      const rule = limits.spendRules.find((r: SpendRule) => (!r.tools || r.tools.includes(e.tool)) && e.amountCents <= r.maxCents);
      [outcome, why] = rule ? [rule.outcome === "observe" ? "observe" : "auto", `rule "${rule.name}"`] : ["ask", "no rule covers it"];
    } else [outcome, why] = ["auto", "within limits"];
    if (outcome === "auto" && limits.observeAboveCents !== null && e.amountCents > limits.observeAboveCents) [outcome, why] = ["observe", "over the review line"];
    if (outcome === "auto" || outcome === "observe") done.push({ at: t, cents: e.amountCents });
    return { ...e, outcome, why };
  });
}

/** Replay the agent's last 30 days of paid calls under the new limits. */
export async function dryRun(db: Db, agentKey: AgentKey, limits: ParsedPolicy["limits"]) {
  const { rows } = await db.query(
    `SELECT h.created_at AS at, COALESCE(t.slug, h.external_protocol) AS tool, COALESCE(h.captured_cents, h.amount_cents) AS "amountCents", h.decision AS before
       FROM holds h LEFT JOIN tools t ON t.id = h.tool_id
      WHERE h.agent_key_id = $1 AND h.status <> 'released' AND NOT h.test AND h.created_at > now() - interval '30 days' AND COALESCE(h.captured_cents, h.amount_cents) > 0
      ORDER BY h.created_at`,
    [agentKey.id],
  );
  const results = simulate(limits, rows);
  const count = (o: SimOutcome) => results.filter((r) => r.outcome === o).length;
  return {
    payments: results.length,
    wouldPayOnItsOwn: count("auto"),
    wouldPayAndFlag: count("observe"),
    wouldAsk: count("ask"),
    wouldBlock: count("blocked"),
    spentOnItsOwnCents: results.filter((r) => r.outcome === "auto" || r.outcome === "observe").reduce((s, r) => s + r.amountCents, 0),
    changed: results
      .filter((r, i) => (rows[i].before === "approved" ? "ask" : rows[i].before === "covered" ? "auto" : rows[i].before) !== r.outcome)
      .slice(0, 10)
      .map((r, i) => ({ at: r.at, tool: r.tool, amountCents: r.amountCents, before: rows[results.indexOf(r)].before, after: r.outcome, why: r.why })),
  };
}

/** Plain lines saying what changes from the current limits. */
export function describeChanges(current: AgentKey, next: ParsedPolicy["limits"]): string[] {
  const out: string[] = [];
  const money = (c: number | null) => (c === null ? "no limit" : usd(c));
  const cmp = (label: string, a: number | null, b: number | null) => a !== b && out.push(`${label}: ${money(a)} → ${money(b)}`);
  if (current.level !== next.level) out.push(`Level: ${current.level} → ${next.level}`);
  cmp("Per payment", current.perCallMaxCents, next.perCallMaxCents);
  cmp("Daily", current.dailyCapCents, next.dailyCapCents);
  cmp("30 days", current.monthlyCapCents, next.monthlyCapCents);
  cmp("Ask over", current.approvalThresholdCents, next.approvalThresholdCents);
  cmp("Flag over", current.observeAboveCents, next.observeAboveCents);
  if (JSON.stringify(current.spendRules) !== JSON.stringify(next.spendRules)) out.push(`Rules: ${next.spendRules.length ? next.spendRules.map((r) => `${r.tools?.join("/") ?? "any tool"} up to ${usd(r.maxCents)}${r.outcome === "observe" ? " (flagged)" : ""}`).join("; ") : "none"}`);
  if (JSON.stringify(current.allowedToolSlugs) !== JSON.stringify(next.allowedToolSlugs)) out.push(`Tools: ${next.allowedToolSlugs?.join(", ") ?? "any"}`);
  return out;
}
