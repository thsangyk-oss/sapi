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

export async function loadCodexData() {
  ensureFile();
  const text = fs.readFileSync(FILE, "utf-8");
  let raw;
  try { raw = JSON.parse(text); } catch { raw = emptyData(); }
  return normalize(raw);
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
