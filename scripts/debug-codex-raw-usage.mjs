// Debug: fetch the raw Codex usage payload for ONE account (by email) and dump
// it verbatim so we can see every field the upstream returns. Used to figure
// out whether token counts are exposed anywhere.
//
// Run from sapi root:  node scripts/debug-codex-raw-usage.mjs [email_substring]
// If no arg given, uses the first codex OAuth account in db.json.

import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const DATA_DIR = process.env.DATA_DIR
  || path.join(process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming"), "sapi");
const DB_PATH = path.join(DATA_DIR, "db.json");

const db = JSON.parse(fs.readFileSync(DB_PATH, "utf-8"));
const codex = (db.providerConnections || []).filter(
  (c) => c.provider === "codex" && c.authType === "oauth" && c.accessToken
);

const filter = process.argv[2];
const pick = filter
  ? codex.find((c) => (c.email || "").toLowerCase().includes(filter.toLowerCase()))
  : codex[0];

if (!pick) {
  console.error("No matching codex acc found.");
  process.exit(1);
}

console.log(`Using acc: ${pick.email}  (id=${pick.id})`);
console.log(`plan: ${pick.providerSpecificData?.chatgptPlanType}`);

const res = await fetch("https://chatgpt.com/backend-api/wham/usage", {
  headers: {
    Authorization: `Bearer ${pick.accessToken}`,
    Accept: "application/json",
  },
});

console.log(`HTTP ${res.status}`);
if (!res.ok) {
  console.log(await res.text());
  process.exit(0);
}

const data = await res.json();
console.log("=== RAW UPSTREAM RESPONSE ===");
console.log(JSON.stringify(data, null, 2));
