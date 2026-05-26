import fs from "fs";
import path from "path";
import { DATA_DIR } from "@/lib/dataDir.js";

const TUNNEL_DIR = path.join(DATA_DIR, "tunnel");
const STATE_FILE = path.join(TUNNEL_DIR, "state.json");
const CLOUDFLARED_PID_FILE = path.join(TUNNEL_DIR, "cloudflared.pid");

function ensureDir() {
  if (!fs.existsSync(TUNNEL_DIR)) {
    fs.mkdirSync(TUNNEL_DIR, { recursive: true });
  }
}

export function loadState() {
  try {
    if (fs.existsSync(STATE_FILE)) {
      return JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
    }
  } catch (e) { /* ignore corrupt state */ }
  return null;
}

export function saveState(state) {
  ensureDir();
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

export function clearState() {
  try {
    if (fs.existsSync(STATE_FILE)) fs.unlinkSync(STATE_FILE);
  } catch (e) { /* ignore */ }
}

// Cloudflare-specific PID
export function savePid(pid) {
  ensureDir();
  fs.writeFileSync(CLOUDFLARED_PID_FILE, pid.toString());
}

export function loadPid() {
  try {
    if (fs.existsSync(CLOUDFLARED_PID_FILE)) {
      return parseInt(fs.readFileSync(CLOUDFLARED_PID_FILE, "utf8"));
    }
  } catch (e) { /* ignore */ }
  return null;
}

export function clearPid() {
  try {
    if (fs.existsSync(CLOUDFLARED_PID_FILE)) fs.unlinkSync(CLOUDFLARED_PID_FILE);
  } catch (e) { /* ignore */ }
}

export const TUNNEL_DATA_DIR = TUNNEL_DIR;
