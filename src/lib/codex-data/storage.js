import path from "node:path";
import fs from "node:fs";
import lockfile from "proper-lockfile";
import { DATA_DIR } from "@/lib/dataDir.js";

const FILE = path.join(DATA_DIR, "codex-data.json");
const GROUPS = ["group2", "group3", "group4", "group5", "groupError"];
const LOCK_OPTIONS = { retries: { retries: 15, minTimeout: 50, maxTimeout: 3000 }, stale: 10000 };

function emptyData() {
  return {
    version: 1,
    groups: { group2: [], group3: [], group4: [], group5: [], groupError: [] },
    updatedAt: new Date().toISOString(),
  };
}

function ensureFile() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(FILE)) fs.writeFileSync(FILE, JSON.stringify(emptyData(), null, 2));
}

function normalize(raw) {
  const data = raw && typeof raw === "object" ? raw : {};
  if (!data.groups || typeof data.groups !== "object") data.groups = {};
  for (const g of GROUPS) {
    if (!Array.isArray(data.groups[g])) data.groups[g] = [];
  }
  data.version = data.version || 1;
  data.updatedAt = data.updatedAt || new Date().toISOString();
  return data;
}

async function withLock(fn) {
  ensureFile();
  const release = await lockfile.lock(FILE, LOCK_OPTIONS);
  try {
    return await fn();
  } finally {
    try { await release(); } catch { /* lock already released */ }
  }
}

// Critical: never silently return emptyData() on parse failure. That would
// trick the scheduler into thinking 371+ accounts vanished and (worse) the
// next `saveCodexData` would overwrite the corrupt file with empty groups.
// On corruption: preserve a timestamped copy, restore from .bak if usable,
// otherwise throw so the operator notices before any write happens.
const BAK_FILE = FILE + ".bak";

function snapshotBackup(text) {
  try {
    if (!text || !text.trim()) return;
    JSON.parse(text); // confirm parseable
    fs.writeFileSync(BAK_FILE, text);
  } catch { /* leave old backup */ }
}

export async function loadCodexData() {
  ensureFile();
  const text = fs.readFileSync(FILE, "utf-8");
  try {
    const raw = JSON.parse(text);
    // Refresh rolling backup after a confirmed-good read.
    snapshotBackup(text);
    return normalize(raw);
  } catch (err) {
    const ts = new Date().toISOString().replace(/[:.]/g, "-");
    const corruptPath = `${FILE}.corrupt.${ts}`;
    try {
      fs.copyFileSync(FILE, corruptPath);
      console.error(`[codex-data] Corrupt codex-data.json — saved bad copy to ${corruptPath}`);
    } catch { /* ignore */ }
    // Try the rolling backup.
    if (fs.existsSync(BAK_FILE)) {
      try {
        const bakText = fs.readFileSync(BAK_FILE, "utf-8");
        const bak = JSON.parse(bakText);
        // Restore the live file from backup so subsequent writes are safe.
        fs.writeFileSync(FILE, bakText);
        console.warn(`[codex-data] Restored from codex-data.json.bak`);
        return normalize(bak);
      } catch { /* fall through */ }
    }
    throw new Error(
      `codex-data.json is corrupt and no usable backup found. ` +
      `Original preserved at ${corruptPath}. Fix or restore the file before the scheduler runs again. ` +
      `(Underlying parse error: ${err.message})`
    );
  }
}

export async function saveCodexData(data) {
  return withLock(async () => {
    const next = normalize(data);
    next.updatedAt = new Date().toISOString();
    fs.writeFileSync(FILE, JSON.stringify(next, null, 2));
    return next;
  });
}

export function isValidGroup(name) {
  return GROUPS.includes(name);
}

export const GROUP_NAMES = GROUPS;

export async function addAccountToGroup(group, account) {
  if (!isValidGroup(group)) throw new Error(`Invalid group: ${group}`);
  return withLock(async () => {
    const data = normalize(JSON.parse(fs.readFileSync(FILE, "utf-8")));
    // Remove any existing entry with same id from any group (account moves are atomic)
    for (const g of GROUPS) {
      data.groups[g] = data.groups[g].filter((a) => a.id !== account.id);
    }
    data.groups[group].push(account);
    data.updatedAt = new Date().toISOString();
    fs.writeFileSync(FILE, JSON.stringify(data, null, 2));
    return data;
  });
}

export async function removeAccountFromGroup(group, accountId) {
  if (!isValidGroup(group)) throw new Error(`Invalid group: ${group}`);
  return withLock(async () => {
    const data = normalize(JSON.parse(fs.readFileSync(FILE, "utf-8")));
    const before = data.groups[group].length;
    data.groups[group] = data.groups[group].filter((a) => a.id !== accountId);
    if (data.groups[group].length === before) return { data, removed: null };
    data.updatedAt = new Date().toISOString();
    fs.writeFileSync(FILE, JSON.stringify(data, null, 2));
    return { data, removed: accountId };
  });
}

export async function findAccountAcrossGroups(accountId) {
  const data = await loadCodexData();
  for (const g of GROUPS) {
    const found = data.groups[g].find((a) => a.id === accountId);
    if (found) return { group: g, account: found };
  }
  return null;
}

export async function updateAccountInGroup(group, accountId, patch) {
  if (!isValidGroup(group)) throw new Error(`Invalid group: ${group}`);
  return withLock(async () => {
    const data = normalize(JSON.parse(fs.readFileSync(FILE, "utf-8")));
    const idx = data.groups[group].findIndex((a) => a.id === accountId);
    if (idx === -1) return null;
    data.groups[group][idx] = { ...data.groups[group][idx], ...patch };
    data.updatedAt = new Date().toISOString();
    fs.writeFileSync(FILE, JSON.stringify(data, null, 2));
    return data.groups[group][idx];
  });
}
