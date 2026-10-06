import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateKeyPairSync } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { verifyEvidenceBundle, type AgentPayKey } from "../packages/verify/src/index.js";
import type { Db } from "../src/db.js";
import { lockInVault } from "../src/controls.js";
import { exportEvidence } from "../src/evidence.js";
import { callPaidTool } from "../src/gateway.js";
import { reportIncident } from "../src/incidents.js";
import { publicKeys } from "../src/signing.js";
import { fakeFetch, freshDb, setup } from "./helpers.js";

let db: Db;
beforeAll(async () => {
  db = await freshDb();
});
afterAll(() => db.end());

describe("evidence bundles", () => {
  it("export a signed slice of the why log that checks out independently, and catch any change", async () => {
    const s = await setup(db, { credit: 1000 });
    await callPaidTool(db, s.agentKey, { tool: s.tool.slug, input: { q: "a" }, idempotencyKey: "e1", reason: "owner asked" }, { fetchImpl: fakeFetch().impl });
    await lockInVault(db, s.user.id, 100);
    const incident = await reportIncident(db, s.user.id, { description: "the agent bought the wrong thing" });
    const bundle = await exportEvidence(db, s.user.id, { incidentId: incident.id });
    const { keys } = await publicKeys(db);

    expect(bundle).toMatchObject({ format: "agentpay-evidence-v1", firstSeq: 1, lastSeq: 3, reason: expect.stringMatching(/^incident .*wrong thing/) });
    expect(verifyEvidenceBundle(bundle as any, keys as AgentPayKey[])).toMatchObject({ ok: true, entries: 3 });

    const edited = structuredClone(bundle) as any;
    edited.entries[0].summary = "Paid $0.01 for something else";
    expect(verifyEvidenceBundle(edited, keys as AgentPayKey[])).toMatchObject({ ok: false, problem: "an entry was changed", seq: 1 });

    const dropped = structuredClone(bundle) as any;
    dropped.entries.splice(1, 1);
    expect(verifyEvidenceBundle(dropped, keys as AgentPayKey[])).toMatchObject({ ok: false, problem: "an entry is missing or out of order" });

    const otherKey = generateKeyPairSync("ed25519").publicKey.export({ type: "spki", format: "pem" }).toString();
    expect(verifyEvidenceBundle(bundle as any, [{ kid: bundle.signature.kid, alg: "Ed25519", publicKeyPem: otherKey }])).toMatchObject({ ok: false });

    // The command-line verifier gives the same answer.
    const dir = mkdtempSync(join(tmpdir(), "evidence-"));
    writeFileSync(join(dir, "bundle.json"), JSON.stringify(bundle));
    writeFileSync(join(dir, "keys.json"), JSON.stringify({ keys }));
    const out = execFileSync(process.execPath, [join("packages", "verify", "dist", "cli.js"), "evidence", join(dir, "bundle.json"), "--keys", join(dir, "keys.json")]).toString();
    expect(out).toMatch(/^OK: 3 entries/);
  });
});
