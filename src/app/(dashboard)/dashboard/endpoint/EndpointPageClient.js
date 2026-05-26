"use client";

import { useState, useEffect, useRef } from "react";
import PropTypes from "prop-types";
import { Card, Button, Input, Modal, CardSkeleton, Toggle } from "@/shared/components";
import { useCopyToClipboard } from "@/shared/hooks/useCopyToClipboard";

const STATUS_POLL_INTERVAL_MS = 5000;
const AUTHORIZE_POLL_INTERVAL_MS = 2500;

const CAVEMAN_LEVELS = [
  { id: "lite", label: "Lite", desc: "Drop filler, keep grammar" },
  { id: "full", label: "Full", desc: "Drop articles, fragments OK" },
  { id: "ultra", label: "Ultra", desc: "Telegraphic, max compression" },
];
export default function APIPageClient({ machineId }) {
  const [keys, setKeys] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showAddModal, setShowAddModal] = useState(false);
  const [newKeyName, setNewKeyName] = useState("");
  const [createdKey, setCreatedKey] = useState(null);

  const [requireApiKey, setRequireApiKey] = useState(false);
  const [requireLogin, setRequireLogin] = useState(true);
  const [hasPassword, setHasPassword] = useState(true);
  const [tunnelDashboardAccess, setTunnelDashboardAccess] = useState(false);
  const [rtkEnabled, setRtkEnabledState] = useState(true);
  const [cavemanEnabled, setCavemanEnabled] = useState(false);
  const [cavemanLevel, setCavemanLevel] = useState("full");

  // Cloudflare Tunnel state — named-tunnel flow
  // tunnel = full status payload from /api/tunnel/status: { authorized, zones, subdomains, ... }
  const [tunnel, setTunnel] = useState(null);
  const [tunnelChecking, setTunnelChecking] = useState(true);
  const [tunnelStatus, setTunnelStatus] = useState(null);          // { type, message } banner
  const [showAuthorizeModal, setShowAuthorizeModal] = useState(false);
  const [showRevokeModal, setShowRevokeModal] = useState(false);
  const [authStarting, setAuthStarting] = useState(false);
  // Add-subdomain inline form state
  const [addingSubdomain, setAddingSubdomain] = useState(false);
  const [newSubLabel, setNewSubLabel] = useState("");
  const [newSubZone, setNewSubZone] = useState("");
  const [subSubmitting, setSubSubmitting] = useState(false);
  const [subError, setSubError] = useState("");

  // API key visibility toggle state
  const [visibleKeys, setVisibleKeys] = useState(new Set());
  // Per-key 24h stats + activity: { [keyId]: { tokens24h, requests24h, lastUsedTs, activeNow } }
  const [keyStats, setKeyStats] = useState({});
  // Inline rename state: { id, value } or null
  const [renaming, setRenaming] = useState(null);

  const { copied, copy } = useCopyToClipboard();

  useEffect(() => {
    fetchData();
    loadSettings();
    fetchKeyStats();
    // Poll status periodically + on tab visible to sync after watchdog restarts
    const interval = setInterval(() => { syncTunnelStatus(); }, STATUS_POLL_INTERVAL_MS);
    // Faster cadence for key activity so the yellow glow tracks live requests
    const keyInterval = setInterval(() => { fetchKeyStats(); }, 3000);
    const onVisible = () => { if (!document.hidden) { syncTunnelStatus(); fetchKeyStats(); } };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      clearInterval(interval);
      clearInterval(keyInterval);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, []);

  // Poll authorize state more aggressively while the modal is open
  useEffect(() => {
    if (!showAuthorizeModal) return;
    const id = setInterval(() => { syncTunnelStatus(); }, AUTHORIZE_POLL_INTERVAL_MS);
    return () => clearInterval(id);
  }, [showAuthorizeModal]);

  // Auto-close the authorize modal once cert.pem is parsed and at least one zone is detected
  useEffect(() => {
    if (showAuthorizeModal && tunnel?.authorized) {
      setShowAuthorizeModal(false);
      setTunnelStatus({ type: "success", message: `Authorized: ${(tunnel.zones || []).join(", ")}` });
    }
  }, [tunnel?.authorized, tunnel?.zones, showAuthorizeModal]);

  const fetchKeyStats = async () => {
    try {
      const res = await fetch("/api/keys/stats", { cache: "no-store" });
      if (!res.ok) return;
      const data = await res.json();
      setKeyStats(data.stats || {});
    } catch { /* ignore poll errors */ }
  };

  const syncTunnelStatus = async () => {
    try {
      const res = await fetch("/api/tunnel/status", { cache: "no-store" });
      if (!res.ok) return;
      const data = await res.json();
      setTunnel(data.tunnel || null);
    } catch { /* ignore poll errors */ }
  };

  const loadSettings = async () => {
    setTunnelChecking(true);
    try {
      const [settingsRes, statusRes] = await Promise.all([
        fetch("/api/settings"),
        fetch("/api/tunnel/status", { cache: "no-store" }),
      ]);
      if (settingsRes.ok) {
        const data = await settingsRes.json();
        setRequireApiKey(data.requireApiKey || false);
        setRequireLogin(data.requireLogin !== false);
        setHasPassword(data.hasPassword || false);
        setTunnelDashboardAccess(data.tunnelDashboardAccess || false);
        setRtkEnabledState(data.rtkEnabled !== false);
        setCavemanEnabled(!!data.cavemanEnabled);
        setCavemanLevel(data.cavemanLevel || "full");
      }
      if (statusRes.ok) {
        const data = await statusRes.json();
        setTunnel(data.tunnel || null);
      }
    } catch (error) {
      console.log("Error loading settings:", error);
    } finally {
      setTunnelChecking(false);
    }
  };

  const handleTunnelDashboardAccess = async (value) => {
    try {
      const res = await fetch("/api/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tunnelDashboardAccess: value }),
      });
      if (res.ok) setTunnelDashboardAccess(value);
    } catch (error) {
      console.log("Error updating tunnelDashboardAccess:", error);
    }
  };

  const handleRequireApiKey = async (value) => {
    try {
      const res = await fetch("/api/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ requireApiKey: value }),
      });
      if (res.ok) setRequireApiKey(value);
    } catch (error) {
      console.log("Error updating requireApiKey:", error);
    }
  };

  const handleRtkEnabled = async (value) => {
    try {
      const res = await fetch("/api/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rtkEnabled: value }),
      });
      if (res.ok) setRtkEnabledState(value);
    } catch (error) {
      console.log("Error updating rtkEnabled:", error);
    }
  };

  const patchSetting = async (patch) => {
    try {
      await fetch("/api/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      });
    } catch (error) {
      console.log("Error updating setting:", error);
    }
  };

  const handleCavemanEnabled = (value) => {
    setCavemanEnabled(value);
    patchSetting({ cavemanEnabled: value });
  };

  const handleCavemanLevel = (level) => {
    setCavemanLevel(level);
    patchSetting({ cavemanLevel: level });
  };

  const fetchData = async () => {
    try {
      const keysRes = await fetch("/api/keys");
      const keysData = await keysRes.json();
      if (keysRes.ok) {
        setKeys(keysData.keys || []);
      }
    } catch (error) {
      console.log("Error fetching data:", error);
    } finally {
      setLoading(false);
    }
  };

  // ─── Cloudflare Named Tunnel handlers ───────────────────────────────────────
  const startAuthorize = async () => {
    if (!requireApiKey) {
      setTunnelStatus({ type: "error", message: "Enable \"Require API key\" before authorizing the tunnel." });
      return;
    }
    setAuthStarting(true);
    setTunnelStatus(null);
    try {
      const res = await fetch("/api/tunnel/authorize", { method: "POST" });
      const data = await res.json();
      if (!res.ok) {
        setTunnelStatus({ type: "error", message: data.error || "Failed to start authorization" });
        return;
      }
      setTunnel((t) => ({ ...(t || {}), ...data }));
      // Already-authorized fast path: cert.pem already exists (e.g. user ran
      // `cloudflared tunnel login` directly some time ago). No modal needed.
      if (data.alreadyAuthorized || data.authorized) {
        setTunnelStatus({ type: "success", message: `Authorized: ${(data.zones || []).join(", ") || "Cloudflare account"}` });
        return;
      }
      // Otherwise we need to send the user to Cloudflare to pick a zone.
      setShowAuthorizeModal(true);
      if (data.loginUrl && typeof window !== "undefined") {
        try { window.open(data.loginUrl, "_blank", "noopener,noreferrer"); } catch { /* ignore */ }
      }
    } catch (e) {
      setTunnelStatus({ type: "error", message: e.message });
    } finally {
      setAuthStarting(false);
    }
  };

  const cancelAuthorize = async () => {
    try { await fetch("/api/tunnel/authorize", { method: "DELETE" }); } catch {}
    setShowAuthorizeModal(false);
    syncTunnelStatus();
  };

  const revokeAuthorization = async () => {
    setShowRevokeModal(false);
    try {
      const res = await fetch("/api/tunnel/revoke", { method: "POST" });
      const data = await res.json();
      if (!res.ok) {
        setTunnelStatus({ type: "error", message: data.error || "Failed to revoke" });
        return;
      }
      setTunnelStatus({ type: "success", message: "Authorization revoked" });
    } catch (e) {
      setTunnelStatus({ type: "error", message: e.message });
    } finally {
      syncTunnelStatus();
    }
  };

  const submitSubdomain = async () => {
    setSubError("");
    const label = (newSubLabel || "").trim().toLowerCase();
    const zone = (newSubZone || (tunnel?.zones?.[0] || "")).trim().toLowerCase();
    if (!zone) { setSubError("Pick a zone first"); return; }
    if (!label) { setSubError("Enter a subdomain"); return; }
    if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/.test(label)) {
      setSubError("Invalid subdomain"); return;
    }
    const hostname = label === zone || label.endsWith("." + zone) ? label : `${label}.${zone}`;
    setSubSubmitting(true);
    try {
      const res = await fetch("/api/tunnel/subdomains", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ hostname }),
      });
      const data = await res.json();
      if (!res.ok) { setSubError(data.error || "Failed to add subdomain"); return; }
      setTunnel(data.status || null);
      setNewSubLabel("");
      setAddingSubdomain(false);
      setTunnelStatus({ type: "success", message: `Added ${hostname}` });
    } catch (e) {
      setSubError(e.message);
    } finally {
      setSubSubmitting(false);
    }
  };

  const removeSubdomainHandler = async (hostname) => {
    if (!confirm(`Remove ${hostname} from tunnel?\n\nThe Cloudflare DNS record will become orphaned; clean it up via the CF dashboard if needed.`)) return;
    try {
      const res = await fetch(`/api/tunnel/subdomains/${encodeURIComponent(hostname)}`, { method: "DELETE" });
      const data = await res.json();
      if (!res.ok) {
        setTunnelStatus({ type: "error", message: data.error || "Failed to remove" });
        return;
      }
      setTunnel(data.status || null);
      setTunnelStatus({ type: "success", message: `Removed ${hostname}` });
    } catch (e) {
      setTunnelStatus({ type: "error", message: e.message });
    }
  };

  const handleCreateKey = async () => {
    if (!newKeyName.trim()) return;

    try {
      const res = await fetch("/api/keys", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: newKeyName }),
      });
      const data = await res.json();

      if (res.ok) {
        setCreatedKey(data.key);
        await fetchData();
        setNewKeyName("");
        setShowAddModal(false);
      }
    } catch (error) {
      console.log("Error creating key:", error);
    }
  };

  const handleDeleteKey = async (id) => {
    if (!confirm("Delete this API key?")) return;

    try {
      const res = await fetch(`/api/keys/${id}`, { method: "DELETE" });
      if (res.ok) {
        setKeys(keys.filter((k) => k.id !== id));
        // Clean up visibility state
        setVisibleKeys(prev => {
          const next = new Set(prev);
          next.delete(id);
          return next;
        });
      }
    } catch (error) {
      console.log("Error deleting key:", error);
    }
  };

  const handleRenameKey = async (id, name) => {
    const trimmed = (name || "").trim();
    if (!trimmed) { setRenaming(null); return; }
    const current = keys.find((k) => k.id === id);
    if (current && current.name === trimmed) { setRenaming(null); return; }
    try {
      const res = await fetch(`/api/keys/${id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: trimmed }),
      });
      if (res.ok) {
        const data = await res.json();
        setKeys((prev) => prev.map((k) => (k.id === id ? { ...k, name: data.key?.name || trimmed } : k)));
      }
    } catch (error) {
      console.log("Error renaming key:", error);
    } finally {
      setRenaming(null);
    }
  };

  const handleToggleKey = async (id, isActive) => {
    try {
      const res = await fetch(`/api/keys/${id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ isActive }),
      });
      if (res.ok) {
        setKeys(prev => prev.map(k => k.id === id ? { ...k, isActive } : k));
      }
    } catch (error) {
      console.log("Error toggling key:", error);
    }
  };

  const maskKey = (fullKey) => {
    if (!fullKey) return "";
    return fullKey.length > 8 ? fullKey.slice(0, 8) + "..." : fullKey;
  };

  const toggleKeyVisibility = (keyId) => {
    setVisibleKeys(prev => {
      const next = new Set(prev);
      if (next.has(keyId)) next.delete(keyId);
      else next.add(keyId);
      return next;
    });
  };

  const [baseUrl, setBaseUrl] = useState("/v1");

  // Hydration fix: Only access window on client side
  useEffect(() => {
    if (typeof window !== "undefined") {
      setBaseUrl(`${window.location.origin}/v1`);
    }
  }, []);

  if (loading) {
    return (
      <div className="flex flex-col gap-8">
        <CardSkeleton />
        <CardSkeleton />
      </div>
    );
  }

  const currentEndpoint = baseUrl;

  return (
    <div className="flex flex-col gap-8">
      {/* Endpoint Card */}
      <Card>
        <h2 className="text-lg font-semibold mb-4 flex items-center gap-2">
          <span className="material-symbols-outlined text-primary">api</span>
          API Endpoint
        </h2>

        {/* Endpoint rows */}
        <div className="flex flex-col gap-2">
          {/* Local */}
          <EndpointRow
            label="Local"
            url={currentEndpoint}
            copyId="local_url"
            copied={copied}
            onCopy={copy}
          />
        </div>

        <CloudflareTunnelSection
          tunnel={tunnel}
          checking={tunnelChecking}
          banner={tunnelStatus}
          onDismissBanner={() => setTunnelStatus(null)}
          onAuthorize={startAuthorize}
          onRevoke={() => setShowRevokeModal(true)}
          addingSubdomain={addingSubdomain}
          newSubLabel={newSubLabel}
          setNewSubLabel={setNewSubLabel}
          newSubZone={newSubZone}
          setNewSubZone={setNewSubZone}
          onStartAddSubdomain={() => {
            setNewSubLabel("");
            setNewSubZone(tunnel?.zones?.[0] || "");
            setSubError("");
            setAddingSubdomain(true);
          }}
          onCancelAddSubdomain={() => { setAddingSubdomain(false); setSubError(""); }}
          onSubmitSubdomain={submitSubdomain}
          onRemoveSubdomain={removeSubdomainHandler}
          subSubmitting={subSubmitting}
          subError={subError}
          copied={copied}
          onCopy={copy}
          requireApiKey={requireApiKey}
        />

        {/* Security warnings when at least one subdomain is configured */}
        {(tunnel?.subdomains?.length > 0) && (
          <div className="mt-4 flex flex-col gap-2">
            {!requireApiKey && (
              <SecurityWarning
                message="Require API key is disabled — your endpoint is publicly accessible without authentication."
                action={{ label: "Enable", href: "#require-api-key" }}
              />
            )}
            {(!requireLogin || !hasPassword) && (
              <SecurityWarning
                message={
                  !requireLogin
                    ? "Require login is disabled — anyone can access your dashboard via tunnel."
                    : "Dashboard uses the default password — change it in Profile settings."
                }
                action={{
                  label: !requireLogin ? "Enable" : "Change password",
                  href: "/dashboard/profile",
                }}
              />
            )}
          </div>
        )}

        {/* Tunnel dashboard access option */}
        {(tunnel?.subdomains?.length > 0) && (
          <div className="mt-4 pt-4 border-t border-border flex items-center gap-3">
            <Toggle
              checked={tunnelDashboardAccess}
              onChange={() => handleTunnelDashboardAccess(!tunnelDashboardAccess)}
            />
            <div className="flex items-center gap-1.5">
              <p className="font-medium text-sm">Allow dashboard access via tunnel</p>
              <Tooltip text="When enabled, the dashboard can be accessed through any of your tunnel subdomains (login still required). When disabled, dashboard access via tunnel hosts is blocked." />
            </div>
          </div>
        )}
      </Card>

      {/* Token Saver (RTK + Caveman) */}
      <Card id="rtk">
        <div className="flex items-center justify-between mb-2">
          <h2 className="text-lg font-semibold flex items-center gap-2">
            <span className="material-symbols-outlined text-primary">bolt</span>
            Token Saver
          </h2>
        </div>
        <div className="flex items-center justify-between pt-2 pb-4 border-b border-border gap-4">
          <div className="min-w-0 flex-1">
            <p className="font-medium">
              Compress tool output{" "}
              <a
                href="https://github.com/rtk-ai/rtk"
                target="_blank"
                rel="noreferrer"
                className="text-xs font-normal text-primary underline hover:opacity-80"
              >
                (RTK)
              </a>
            </p>
            <p className="text-sm text-text-muted">
              git/grep/ls/tree/logs → 60-90% fewer input tokens
            </p>
          </div>
          <Toggle
            checked={rtkEnabled}
            onChange={() => handleRtkEnabled(!rtkEnabled)}
          />
        </div>
        <div className="flex items-center justify-between pt-4 gap-4 flex-wrap">
          <div className="min-w-0 flex-1">
            <p className="font-medium">
              Compress LLM output{" "}
              <a
                href="https://github.com/JuliusBrussee/caveman"
                target="_blank"
                rel="noreferrer"
                className="text-xs font-normal text-primary underline hover:opacity-80"
              >
                (Caveman)
              </a>
            </p>
            <p className="text-sm text-text-muted">
              Terse-style system prompt → ~65% fewer output tokens (up to 87%)
            </p>
          </div>
          <div className="flex items-center gap-3 shrink-0">
            {cavemanEnabled && (
              <div className="flex items-center gap-1.5">
                {CAVEMAN_LEVELS.map((lvl) => (
                  <button
                    key={lvl.id}
                    onClick={() => handleCavemanLevel(lvl.id)}
                    className={`px-3 py-1.5 rounded text-xs font-medium border transition-colors ${
                      cavemanLevel === lvl.id
                        ? "bg-primary text-white border-primary"
                        : "bg-transparent border-border text-text-muted hover:bg-surface-2"
                    }`}
                    title={lvl.desc}
                  >
                    {lvl.label}
                  </button>
                ))}
              </div>
            )}
            <Toggle
              checked={cavemanEnabled}
              onChange={() => handleCavemanEnabled(!cavemanEnabled)}
            />
          </div>
        </div>
      </Card>

      {/* API Keys */}
      <Card id="require-api-key">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-semibold flex items-center gap-2">
            <span className="material-symbols-outlined text-primary">vpn_key</span>
            API Keys
          </h2>
          <Button icon="add" onClick={() => setShowAddModal(true)}>
            Create Key
          </Button>
        </div>

        <div className="flex items-center justify-between pb-4 mb-4 border-b border-border">
          <div>
            <p className="font-medium">Require API key</p>
            <p className="text-sm text-text-muted">
              Requests without a valid key will be rejected
            </p>
          </div>
          <Toggle
            checked={requireApiKey}
            onChange={() => handleRequireApiKey(!requireApiKey)}
          />
        </div>

        {keys.length === 0 ? (
          <div className="text-center py-12">
            <div className="inline-flex items-center justify-center w-16 h-16 rounded-full bg-primary/10 text-primary mb-4">
              <span className="material-symbols-outlined text-[32px]">vpn_key</span>
            </div>
            <p className="text-text-main font-medium mb-1">No API keys yet</p>
            <p className="text-sm text-text-muted mb-4">Create your first API key to get started</p>
            <Button icon="add" onClick={() => setShowAddModal(true)}>
              Create Key
            </Button>
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            {keys.map((key) => (
              <ApiKeyCard
                key={key.id}
                apiKey={key}
                stats={keyStats[key.id]}
                isRenaming={renaming?.id === key.id}
                renameValue={renaming?.id === key.id ? renaming.value : ""}
                onRenameStart={(name) => setRenaming({ id: key.id, value: name })}
                onRenameChange={(value) => setRenaming({ id: key.id, value })}
                onRenameSubmit={() => handleRenameKey(key.id, renaming?.value)}
                onRenameCancel={() => setRenaming(null)}
                isVisible={visibleKeys.has(key.id)}
                onToggleVisibility={() => toggleKeyVisibility(key.id)}
                onCopy={() => copy(key.key, key.id)}
                copied={copied === key.id}
                onDelete={() => handleDeleteKey(key.id)}
                onToggleActive={(checked) => {
                  if (key.isActive && !checked) {
                    if (confirm(`Pause API key "${key.name}"?\n\nThis key will stop working immediately but can be resumed later.`)) {
                      handleToggleKey(key.id, checked);
                    }
                  } else {
                    handleToggleKey(key.id, checked);
                  }
                }}
                maskKey={maskKey}
              />
            ))}
          </div>
        )}
      </Card>

      {/* Add Key Modal */}
      <Modal
        isOpen={showAddModal}
        title="Create API Key"
        onClose={() => {
          setShowAddModal(false);
          setNewKeyName("");
        }}
      >
        <div className="flex flex-col gap-4">
          <Input
            label="Key Name"
            value={newKeyName}
            onChange={(e) => setNewKeyName(e.target.value)}
            placeholder="Production Key"
          />
          <div className="flex gap-2">
            <Button onClick={handleCreateKey} fullWidth disabled={!newKeyName.trim()}>
              Create
            </Button>
            <Button
              onClick={() => {
                setShowAddModal(false);
                setNewKeyName("");
              }}
              variant="ghost"
              fullWidth
            >
              Cancel
            </Button>
          </div>
        </div>
      </Modal>

      {/* Created Key Modal */}
      <Modal
        isOpen={!!createdKey}
        title="API Key Created"
        onClose={() => setCreatedKey(null)}
      >
        <div className="flex flex-col gap-4">
          <div className="bg-yellow-50 dark:bg-yellow-900/20 border border-yellow-200 dark:border-yellow-800 rounded-lg p-4">
            <p className="text-sm text-yellow-800 dark:text-yellow-200 mb-2 font-medium">
              Save this key now!
            </p>
            <p className="text-sm text-yellow-700 dark:text-yellow-300">
              This is the only time you will see this key. Store it securely.
            </p>
          </div>
          <div className="flex gap-2">
            <Input
              value={createdKey || ""}
              readOnly
              className="flex-1 font-mono text-sm"
            />
            <Button
              variant="secondary"
              icon={copied === "created_key" ? "check" : "content_copy"}
              onClick={() => copy(createdKey, "created_key")}
            >
              {copied === "created_key" ? "Copied!" : "Copy"}
            </Button>
          </div>
          <Button onClick={() => setCreatedKey(null)} fullWidth>
            Done
          </Button>
        </div>
      </Modal>

      {/* Authorize (cloudflared tunnel login) Modal */}
      <Modal
        isOpen={showAuthorizeModal}
        title="Authorize a Cloudflare domain"
        onClose={() => { if (!authStarting && !tunnel?.login?.inProgress) setShowAuthorizeModal(false); }}
      >
        <div className="flex flex-col gap-4">
          <p className="text-sm text-text-muted">
            Open the URL below in a browser logged into your Cloudflare account and pick the
            zone you want to expose. SAPI will detect the certificate automatically when
            authorization completes.
          </p>

          {authStarting && (
            <div className="flex items-center gap-2 text-sm text-text-muted">
              <span className="material-symbols-outlined animate-spin text-sm">progress_activity</span>
              Starting cloudflared…
            </div>
          )}

          {tunnel?.login?.loginUrl && (
            <div className="flex flex-col gap-2">
              <label className="text-xs font-medium text-text-muted">Authorization URL</label>
              <div className="flex gap-2">
                <Input value={tunnel.login.loginUrl} readOnly className="flex-1 font-mono text-xs" />
                <Button
                  size="sm"
                  variant="secondary"
                  icon={copied === "auth_url" ? "check" : "content_copy"}
                  onClick={() => copy(tunnel.login.loginUrl, "auth_url")}
                >
                  {copied === "auth_url" ? "Copied" : "Copy"}
                </Button>
                <Button size="sm" icon="open_in_new" onClick={() => window.open(tunnel.login.loginUrl, "_blank", "noopener")}>
                  Open
                </Button>
              </div>
              <p className="text-xs text-text-subtle">
                Waiting for you to pick a zone in Cloudflare. This dialog closes automatically.
              </p>
            </div>
          )}

          {tunnel?.login?.error && (
            <StatusAlert status={{ type: "error", message: tunnel.login.error }} />
          )}

          <div className="flex gap-2">
            <Button onClick={cancelAuthorize} variant="ghost" fullWidth>Cancel</Button>
          </div>
        </div>
      </Modal>

      {/* Revoke modal */}
      <Modal
        isOpen={showRevokeModal}
        title="Revoke Cloudflare authorization"
        onClose={() => setShowRevokeModal(false)}
      >
        <div className="flex flex-col gap-4">
          <p className="text-sm text-text-muted">
            This stops the tunnel, deletes the Cloudflare tunnel registration and the local
            certificate. DNS records on your zone become orphaned — clean them up in the
            Cloudflare dashboard if you do not plan to re-add the same subdomains.
          </p>
          <div className="flex gap-2">
            <Button onClick={revokeAuthorization} variant="danger" fullWidth>Revoke</Button>
            <Button onClick={() => setShowRevokeModal(false)} variant="ghost" fullWidth>Cancel</Button>
          </div>
        </div>
      </Modal>
    </div>
  );
}

const ACTIVITY_GLOW_WINDOW_MS = 2 * 60 * 1000;

function formatTokens(n) {
  if (!n || n <= 0) return "0";
  if (n < 1000) return String(n);
  if (n < 1_000_000) return (n / 1000).toFixed(n < 10_000 ? 1 : 0).replace(/\.0$/, "") + "k";
  return (n / 1_000_000).toFixed(n < 10_000_000 ? 1 : 0).replace(/\.0$/, "") + "M";
}

function formatRelativeTime(tsMs) {
  if (!tsMs) return "never";
  const diff = Date.now() - tsMs;
  if (diff < 5_000) return "just now";
  if (diff < 60_000) return `${Math.floor(diff / 1000)}s ago`;
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return `${Math.floor(diff / 86_400_000)}d ago`;
}

/**
 * API Key card with glow-on-activity, inline rename, prominent copy/show/delete,
 * and a 24h token/request counter sourced from /api/keys/stats.
 */
function ApiKeyCard({
  apiKey, stats, isRenaming, renameValue, onRenameStart, onRenameChange,
  onRenameSubmit, onRenameCancel, isVisible, onToggleVisibility, onCopy, copied,
  onDelete, onToggleActive, maskKey,
}) {
  const renameInputRef = useRef(null);
  const [tick, setTick] = useState(0);

  // Drive relative-time labels + glow window without re-polling stats
  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), 5000);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    if (isRenaming && renameInputRef.current) {
      renameInputRef.current.focus();
      renameInputRef.current.select();
    }
  }, [isRenaming]);

  const paused = apiKey.isActive === false;
  const lastUsedTs = stats?.lastUsedTs || 0;
  const tokens24h = stats?.tokens24h || 0;
  const requests24h = stats?.requests24h || 0;
  // Spec: glow if a request is currently active OR happened within 2 minutes.
  const sinceLast = lastUsedTs ? Date.now() - lastUsedTs : Infinity;
  const isActiveNow = !!stats?.activeNow;
  const recentlyActive = sinceLast < ACTIVITY_GLOW_WINDOW_MS;
  const glow = !paused && (isActiveNow || recentlyActive);
  // Silence the "tick is unused" warning while keeping the interval-driven re-render.
  void tick;

  return (
    <div
      className={`group relative rounded-brand border bg-surface p-4 flex flex-col gap-3 transition-shadow ${
        glow
          ? "animate-key-glow border-yellow-400"
          : "border-border hover:border-border-subtle"
      } ${paused ? "opacity-60" : ""}`}
    >
      {/* Header: name (inline-editable) + status pill */}
      <div className="flex items-start justify-between gap-2 min-w-0">
        <div className="flex-1 min-w-0">
          {isRenaming ? (
            <input
              ref={renameInputRef}
              type="text"
              value={renameValue}
              onChange={(e) => onRenameChange(e.target.value)}
              onBlur={onRenameSubmit}
              onKeyDown={(e) => {
                if (e.key === "Enter") { e.preventDefault(); onRenameSubmit(); }
                else if (e.key === "Escape") { e.preventDefault(); onRenameCancel(); }
              }}
              maxLength={80}
              className="w-full px-2 py-1 -mx-2 -my-1 text-sm font-semibold rounded border border-primary/60 bg-input focus:outline-none focus:ring-2 focus:ring-primary/30"
            />
          ) : (
            <button
              type="button"
              onClick={() => onRenameStart(apiKey.name)}
              className="text-left text-sm font-semibold truncate w-full hover:text-primary transition-colors flex items-center gap-1"
              title="Click to rename"
            >
              <span className="truncate">{apiKey.name}</span>
              <span className="material-symbols-outlined text-[14px] text-text-muted opacity-0 group-hover:opacity-100 transition-opacity shrink-0">edit</span>
            </button>
          )}
          <p className="text-xs text-text-muted mt-0.5">
            Created {new Date(apiKey.createdAt).toLocaleDateString()}
          </p>
        </div>
        <div className="flex items-center gap-1.5 shrink-0">
          {glow && (
            <span className="inline-flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wide px-1.5 py-0.5 rounded bg-yellow-400/15 text-yellow-700 dark:text-yellow-300 border border-yellow-400/40">
              <span className="w-1.5 h-1.5 rounded-full bg-yellow-400 animate-pulse" />
              {isActiveNow ? "Live" : "Active"}
            </span>
          )}
          {paused && (
            <span className="text-[10px] font-semibold uppercase tracking-wide px-1.5 py-0.5 rounded bg-orange-500/10 text-orange-500 border border-orange-500/30">
              Paused
            </span>
          )}
        </div>
      </div>

      {/* Key row: mask + show/copy (always-visible, not hover-only) */}
      <div className="flex items-center gap-1 bg-surface-2 dark:bg-white/[0.03] rounded border border-border-subtle px-2 py-1.5">
        <code className="flex-1 text-xs font-mono truncate text-text-main">
          {isVisible ? apiKey.key : maskKey(apiKey.key)}
        </code>
        <button
          type="button"
          onClick={onToggleVisibility}
          className="p-1.5 rounded text-text-muted hover:text-primary hover:bg-black/5 dark:hover:bg-white/10 transition-colors shrink-0"
          title={isVisible ? "Hide key" : "Show key"}
        >
          <span className="material-symbols-outlined text-[16px]">
            {isVisible ? "visibility_off" : "visibility"}
          </span>
        </button>
        <button
          type="button"
          onClick={onCopy}
          className={`p-1.5 rounded transition-colors shrink-0 ${
            copied
              ? "text-green-600 bg-green-500/10"
              : "text-text-muted hover:text-primary hover:bg-black/5 dark:hover:bg-white/10"
          }`}
          title="Copy key"
        >
          <span className="material-symbols-outlined text-[16px]">
            {copied ? "check" : "content_copy"}
          </span>
        </button>
      </div>

      {/* 24h stats + last-used */}
      <div className="flex items-center justify-between gap-2 text-xs">
        <div className="flex items-center gap-3 min-w-0">
          <span className="inline-flex items-center gap-1 text-text-muted" title="Total tokens in the last 24 hours">
            <span className="material-symbols-outlined text-[14px]">token</span>
            <span className="font-semibold text-text-main">{formatTokens(tokens24h)}</span>
            <span className="text-text-subtle">/ 24h</span>
          </span>
          <span className="inline-flex items-center gap-1 text-text-muted" title="Requests in the last 24 hours">
            <span className="material-symbols-outlined text-[14px]">bar_chart</span>
            <span className="font-semibold text-text-main">{requests24h}</span>
            <span className="text-text-subtle">req</span>
          </span>
        </div>
        <span className="text-text-subtle whitespace-nowrap shrink-0">
          {lastUsedTs ? formatRelativeTime(lastUsedTs) : "no requests yet"}
        </span>
      </div>

      {/* Footer actions: pause toggle + delete */}
      <div className="flex items-center justify-between pt-2 border-t border-border-subtle">
        <div className="flex items-center gap-2 text-xs text-text-muted">
          <Toggle
            size="sm"
            checked={apiKey.isActive ?? true}
            onChange={onToggleActive}
            title={apiKey.isActive ? "Pause key" : "Resume key"}
          />
          <span>{paused ? "Paused" : "Active"}</span>
        </div>
        <button
          type="button"
          onClick={onDelete}
          className="inline-flex items-center gap-1 px-2 py-1 rounded text-xs text-red-500 hover:bg-red-500/10 transition-colors"
          title="Delete key"
        >
          <span className="material-symbols-outlined text-[16px]">delete</span>
          Delete
        </button>
      </div>
    </div>
  );
}

ApiKeyCard.propTypes = {
  apiKey: PropTypes.object.isRequired,
  stats: PropTypes.object,
  isRenaming: PropTypes.bool,
  renameValue: PropTypes.string,
  onRenameStart: PropTypes.func.isRequired,
  onRenameChange: PropTypes.func.isRequired,
  onRenameSubmit: PropTypes.func.isRequired,
  onRenameCancel: PropTypes.func.isRequired,
  isVisible: PropTypes.bool,
  onToggleVisibility: PropTypes.func.isRequired,
  onCopy: PropTypes.func.isRequired,
  copied: PropTypes.bool,
  onDelete: PropTypes.func.isRequired,
  onToggleActive: PropTypes.func.isRequired,
  maskKey: PropTypes.func.isRequired,
};

/**
 * Cloudflare Tunnel section.
 * - Not authorized → big Authorize button + short explanation.
 * - Authorized   → green pill with zone name(s), reconnect indicator, list of
 *   subdomain rows (copy + delete) and an inline "+" form to add more.
 */
function CloudflareTunnelSection({
  tunnel, checking, banner, onDismissBanner,
  onAuthorize, onRevoke,
  addingSubdomain, newSubLabel, setNewSubLabel, newSubZone, setNewSubZone,
  onStartAddSubdomain, onCancelAddSubdomain, onSubmitSubdomain, onRemoveSubdomain,
  subSubmitting, subError,
  copied, onCopy, requireApiKey,
}) {
  const authorized = !!tunnel?.authorized;
  const zones = tunnel?.zones || [];
  const subdomains = tunnel?.subdomains || [];
  const loginInProgress = !!tunnel?.login?.inProgress;
  const reconnecting = !!tunnel?.reconnecting;
  const running = !!tunnel?.running;

  return (
    <div className="mt-4 pt-4 border-t border-border flex flex-col gap-3">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 min-w-0">
          <span className="material-symbols-outlined text-primary text-[18px]">cloud</span>
          <p className="font-semibold text-sm">Cloudflare Tunnel</p>
          {authorized ? (
            <span className="inline-flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wide px-1.5 py-0.5 rounded bg-green-500/15 text-green-700 dark:text-green-300 border border-green-500/40">
              <span className="material-symbols-outlined text-[12px]">verified</span>
              Authorized
            </span>
          ) : checking ? (
            <span className="text-[11px] text-text-muted">Checking…</span>
          ) : null}
          {authorized && subdomains.length > 0 && (
            <span className={`inline-flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wide px-1.5 py-0.5 rounded border ${
              running
                ? "bg-primary/10 text-primary border-primary/30"
                : "bg-orange-500/10 text-orange-500 border-orange-500/30"
            }`}>
              <span className={`w-1.5 h-1.5 rounded-full ${running ? "bg-primary" : "bg-orange-500"} ${reconnecting ? "animate-pulse" : ""}`} />
              {reconnecting ? "Reconnecting" : running ? "Live" : "Stopped"}
            </span>
          )}
        </div>
        {authorized && (
          <button
            type="button"
            onClick={onRevoke}
            className="text-xs text-red-500 hover:underline shrink-0"
            title="Revoke authorization and remove tunnel"
          >
            Revoke
          </button>
        )}
      </div>

      {!authorized && (
        <div className="flex flex-col gap-2">
          <p className="text-xs text-text-muted">
            Connect your own Cloudflare-managed domain. SAPI runs <code className="text-[11px]">cloudflared tunnel login</code> in
            your browser; pick the zone you want to expose. After that you can add subdomain endpoints below.
          </p>
          <div className="flex items-center gap-2">
            <Button
              icon={loginInProgress ? "progress_activity" : "verified_user"}
              onClick={onAuthorize}
              disabled={loginInProgress || !requireApiKey}
              title={!requireApiKey ? "Enable 'Require API key' first" : "Open Cloudflare authorization"}
            >
              {loginInProgress ? "Waiting for browser..." : "Authorize"}
            </Button>
            {!requireApiKey && (
              <p className="text-[11px] text-amber-600 dark:text-amber-400">
                Enable <a href="#require-api-key" className="underline">Require API key</a> first.
              </p>
            )}
          </div>
        </div>
      )}

      {authorized && (
        <div className="flex flex-col gap-2">
          <div className="flex items-center gap-2 text-xs text-text-muted flex-wrap">
            <span>Zone{zones.length > 1 ? "s" : ""}:</span>
            {zones.map((z) => (
              <span key={z} className="font-mono px-1.5 py-0.5 rounded bg-surface-2 text-text-main border border-border-subtle">{z}</span>
            ))}
          </div>

          <div className="flex flex-col gap-1.5">
            {subdomains.length === 0 && (
              <p className="text-xs text-text-subtle italic">No subdomains yet — add one below to expose the endpoint.</p>
            )}
            {subdomains.map((host) => {
              const url = `https://${host}/v1`;
              return (
                <div key={host} className="flex items-center gap-1 bg-surface-2 dark:bg-white/[0.03] rounded border border-border-subtle px-2 py-1.5">
                  <span className="material-symbols-outlined text-[14px] text-primary shrink-0">public</span>
                  <code className="flex-1 text-xs font-mono truncate text-text-main">{url}</code>
                  <button
                    type="button"
                    onClick={() => onCopy(url, `sub_${host}`)}
                    className={`p-1.5 rounded transition-colors shrink-0 ${
                      copied === `sub_${host}`
                        ? "text-green-600 bg-green-500/10"
                        : "text-text-muted hover:text-primary hover:bg-black/5 dark:hover:bg-white/10"
                    }`}
                    title="Copy endpoint URL"
                  >
                    <span className="material-symbols-outlined text-[16px]">{copied === `sub_${host}` ? "check" : "content_copy"}</span>
                  </button>
                  <a
                    href={`https://${host}`}
                    target="_blank"
                    rel="noreferrer"
                    className="p-1.5 rounded text-text-muted hover:text-primary hover:bg-black/5 dark:hover:bg-white/10 transition-colors shrink-0"
                    title="Open in new tab"
                  >
                    <span className="material-symbols-outlined text-[16px]">open_in_new</span>
                  </a>
                  <button
                    type="button"
                    onClick={() => onRemoveSubdomain(host)}
                    className="p-1.5 rounded text-red-500 hover:bg-red-500/10 transition-colors shrink-0"
                    title="Remove subdomain"
                  >
                    <span className="material-symbols-outlined text-[16px]">close</span>
                  </button>
                </div>
              );
            })}
          </div>

          {addingSubdomain ? (
            <div className="flex flex-col gap-1 mt-1">
              <div className="flex items-center gap-1">
                <input
                  type="text"
                  autoFocus
                  value={newSubLabel}
                  onChange={(e) => setNewSubLabel(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") { e.preventDefault(); onSubmitSubdomain(); }
                    else if (e.key === "Escape") { e.preventDefault(); onCancelAddSubdomain(); }
                  }}
                  placeholder="e.g. api"
                  className="flex-1 min-w-0 px-2 py-1.5 text-sm font-mono rounded border border-border bg-input focus:outline-none focus:ring-2 focus:ring-primary/30"
                />
                <span className="text-sm text-text-muted px-1">.</span>
                {zones.length > 1 ? (
                  <select
                    value={newSubZone || zones[0]}
                    onChange={(e) => setNewSubZone(e.target.value)}
                    className="px-2 py-1.5 text-sm font-mono rounded border border-border bg-input focus:outline-none focus:ring-2 focus:ring-primary/30"
                  >
                    {zones.map((z) => <option key={z} value={z}>{z}</option>)}
                  </select>
                ) : (
                  <span className="px-2 py-1.5 text-sm font-mono text-text-main bg-surface-2 rounded border border-border-subtle">
                    {zones[0]}
                  </span>
                )}
                <Button size="sm" onClick={onSubmitSubdomain} disabled={subSubmitting || !newSubLabel.trim()}>
                  {subSubmitting ? "Adding..." : "Add"}
                </Button>
                <Button size="sm" variant="ghost" onClick={onCancelAddSubdomain} disabled={subSubmitting}>
                  Cancel
                </Button>
              </div>
              {subError && <p className="text-xs text-red-500">{subError}</p>}
            </div>
          ) : (
            <button
              type="button"
              onClick={onStartAddSubdomain}
              className="self-start inline-flex items-center gap-1 px-2 py-1 mt-1 rounded text-xs text-primary hover:bg-primary/10 transition-colors border border-dashed border-primary/40"
            >
              <span className="material-symbols-outlined text-[16px]">add</span>
              Add subdomain
            </button>
          )}
        </div>
      )}

      {banner && (
        <div className="flex items-center gap-2">
          <div className="flex-1"><StatusAlert status={banner} /></div>
          <button
            type="button"
            onClick={onDismissBanner}
            className="p-1 rounded text-text-muted hover:text-text-main hover:bg-black/5 dark:hover:bg-white/10"
            title="Dismiss"
          >
            <span className="material-symbols-outlined text-[16px]">close</span>
          </button>
        </div>
      )}
    </div>
  );
}

CloudflareTunnelSection.propTypes = {
  tunnel: PropTypes.object,
  checking: PropTypes.bool,
  banner: PropTypes.object,
  onDismissBanner: PropTypes.func.isRequired,
  onAuthorize: PropTypes.func.isRequired,
  onRevoke: PropTypes.func.isRequired,
  addingSubdomain: PropTypes.bool,
  newSubLabel: PropTypes.string,
  setNewSubLabel: PropTypes.func.isRequired,
  newSubZone: PropTypes.string,
  setNewSubZone: PropTypes.func.isRequired,
  onStartAddSubdomain: PropTypes.func.isRequired,
  onCancelAddSubdomain: PropTypes.func.isRequired,
  onSubmitSubdomain: PropTypes.func.isRequired,
  onRemoveSubdomain: PropTypes.func.isRequired,
  subSubmitting: PropTypes.bool,
  subError: PropTypes.string,
  copied: PropTypes.string,
  onCopy: PropTypes.func.isRequired,
  requireApiKey: PropTypes.bool,
};

/** Reusable endpoint row component */
function EndpointRow({ label, url, copyId, copied, onCopy, badge, actions }) {
  return (
    <div className="flex items-center gap-2">
      <span className={`text-xs font-mono px-1.5 py-0.5 rounded shrink-0 min-w-[88px] text-center ${
          (badge === "CF" || badge === "TS") ? "bg-primary/10 text-primary" : "bg-surface-2 text-text-muted"
        }`}>{label}</span>
      <Input value={url} readOnly className="flex-1 font-mono text-sm" />
      <button
        onClick={() => onCopy(url, copyId)}
        className="p-2 hover:bg-black/5 dark:hover:bg-white/5 rounded text-text-muted hover:text-primary transition-colors shrink-0"
      >
        <span className="material-symbols-outlined text-[18px]">{copied === copyId ? "check" : "content_copy"}</span>
      </button>
      {actions}
    </div>
  );
}

/** Reusable status alert */
function StatusAlert({ status, className = "" }) {
  // Render URLs in message as clickable links
  const renderMessage = (msg) => {
    const parts = msg.split(/(https?:\/\/[^\s]+)/g);
    return parts.map((part, i) =>
      /^https?:\/\//.test(part)
        ? <a key={i} href={part} target="_blank" rel="noreferrer" className="underline font-medium">{part}</a>
        : part
    );
  };

  return (
    <div className={`p-2 rounded text-sm ${className} ${status.type === "success" ? "bg-green-500/10 text-green-600 dark:text-green-400" :
        status.type === "warning" ? "bg-yellow-500/10 text-yellow-600 dark:text-yellow-400" :
        status.type === "info" ? "bg-blue-500/10 text-blue-600 dark:text-blue-400" :
          "bg-red-500/10 text-red-600 dark:text-red-400"
      }`}>
      {renderMessage(status.message)}
    </div>
  );
}

/** Inline tooltip, Claude Code CLI style */
function Tooltip({ text }) {
  return (
    <span className="relative group inline-flex items-center">
      <span className="material-symbols-outlined text-[14px] text-text-muted cursor-help">help</span>
      <span className="pointer-events-none absolute left-5 top-1/2 -translate-y-1/2 z-50 w-64 rounded bg-gray-900 dark:bg-gray-800 text-white text-xs px-2.5 py-1.5 opacity-0 group-hover:opacity-100 transition-opacity shadow-lg">
        {text}
      </span>
    </span>
  );
}

/** Security warning banner with optional action link */
function SecurityWarning({ message, action }) {
  return (
    <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-amber-500/10 border border-amber-500/20 text-amber-700 dark:text-amber-400">
      <span className="material-symbols-outlined text-[16px] shrink-0 mt-0.5">warning</span>
      <p className="text-xs flex-1">{message}</p>
      {action && (
        <a
          href={action.href}
          className="text-xs font-medium underline shrink-0 hover:opacity-80"
          onClick={action.href.startsWith("#") ? (e) => {
            e.preventDefault();
            document.getElementById(action.href.slice(1))?.scrollIntoView({ behavior: "smooth" });
          } : undefined}
        >
          {action.label}
        </a>
      )}
    </div>
  );
}

APIPageClient.propTypes = {
  machineId: PropTypes.string.isRequired,
};
