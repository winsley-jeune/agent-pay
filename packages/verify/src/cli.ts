#!/usr/bin/env node
// SPDX-License-Identifier: MIT
import { readFile } from "node:fs/promises";
import { fetchAgentPayKeys, verifyEvidenceBundle, type AgentPayKey, type EvidenceBundle } from "./index.js";

// npx @winsley-jeune/agentpay-verify evidence bundle.json [--keys keys.json]
// Fetches the issuer's public keys unless a keys file is given.
const [command, file, ...rest] = process.argv.slice(2);
if (command !== "evidence" || !file) {
  console.error("usage: agentpay-verify evidence <bundle.json> [--keys <keys.json>]");
  process.exit(2);
}
const bundle = JSON.parse(await readFile(file, "utf8")) as EvidenceBundle;
const keysAt = rest.indexOf("--keys");
const keys: AgentPayKey[] =
  keysAt >= 0 ? (JSON.parse(await readFile(rest[keysAt + 1], "utf8")) as { keys: AgentPayKey[] }).keys : await fetchAgentPayKeys(bundle.issuer);
const result = verifyEvidenceBundle(bundle, keys);
if (result.ok) {
  console.log(`OK: ${result.entries} entries (#${result.firstSeq}–#${result.lastSeq}), signed by ${result.issuer}`);
} else {
  console.log(`FAILED: ${result.problem}${result.seq !== undefined ? ` (entry #${result.seq})` : ""}`);
  process.exit(1);
}
