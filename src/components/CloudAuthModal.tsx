import { useState, useEffect, useCallback } from "react";
import { Cloud, Key, Check, ExternalLink, Sparkles, X, ShieldCheck, Zap, CheckCircle2, ChevronDown, AlertTriangle } from "lucide-react";
import { open as shellOpen } from "@tauri-apps/plugin-shell";
import { invoke } from "@tauri-apps/api/core";
import { encryptSecret, decryptSecret } from "../utils/crypto";

interface CloudAuthModalProps {
  initialTab?: "cloud" | "byok";
  onClose: () => void;
  onModeChanged?: () => void;
  onOpenBYOKWizard?: () => void;
}

interface ProviderInfo {
  id: string;
  name: string;
  badge: string;
  badgeColor: string;
  keyUrl: string;
  urlLabel: string;
  keyPrefix: string;
  instruction: string;
}

const PROVIDERS: ProviderInfo[] = [
  {
    id: "openrouter",
    name: "OpenRouter",
    badge: "FREE / PAID",
    badgeColor: "linear-gradient(135deg, #6366f1, #8b5cf6)",
    keyUrl: "https://openrouter.ai/keys",
    urlLabel: "Get OpenRouter Key",
    keyPrefix: "sk-or-...",
    instruction: "Free & paid access to Claude 3.5 Sonnet, DeepSeek V3/R1, Llama 3.3 70B & GPT-4o.",
  },
  {
    id: "groq",
    name: "Groq AI",
    badge: "100% FREE",
    badgeColor: "linear-gradient(135deg, #10b981, #059669)",
    keyUrl: "https://console.groq.com/keys",
    urlLabel: "Get Free Groq Key",
    keyPrefix: "gsk_...",
    instruction: "100% free forever. Ultra-fast Llama 3.3 70B AI answers & voice transcription.",
  },
  {
    id: "openai",
    name: "OpenAI",
    badge: "PAID",
    badgeColor: "#3b82f6",
    keyUrl: "https://platform.openai.com/api-keys",
    urlLabel: "Get OpenAI Key",
    keyPrefix: "sk-...",
    instruction: "Official API key for GPT-4o & Whisper real-time audio transcription.",
  },
  {
    id: "anthropic",
    name: "Anthropic",
    badge: "PAID",
    badgeColor: "#d97706",
    keyUrl: "https://console.anthropic.com/settings/keys",
    urlLabel: "Get Anthropic Key",
    keyPrefix: "sk-ant-...",
    instruction: "Official API key for Claude 3.5 Sonnet & Claude 3 Haiku.",
  },
  {
    id: "gemini",
    name: "Google Gemini",
    badge: "FREE / PAID",
    badgeColor: "#ec4899",
    keyUrl: "https://aistudio.google.com/app/apikey",
    urlLabel: "Get Gemini Key",
    keyPrefix: "AIza...",
    instruction: "Official Google AI Studio API key for Gemini 1.5 Flash.",
  },
];

export function CloudAuthModal({ initialTab = "cloud", onClose, onModeChanged, onOpenBYOKWizard }: CloudAuthModalProps) {
  const [activeTab, setActiveTab] = useState<"cloud" | "byok">(initialTab);
  const [cloudEnabled, setCloudEnabled] = useState(false);
  const [jwtInput, setJwtInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [statusMsg, setStatusMsg] = useState<string | null>(null);
  const [hasSavedToken, setHasSavedToken] = useState(false);

  // BYOK Form States
  const [selectedProvider, setSelectedProvider] = useState<string>("openrouter");
  const [byokApiKey, setByokApiKey] = useState("");
  const [transcriptionKey, setTranscriptionKey] = useState("");
  const [byokVerifying, setByokVerifying] = useState(false);
  const [byokStatus, setByokStatus] = useState<{ type: "success" | "error"; message: string } | null>(null);

  const [tokenVerificationStatus, setTokenVerificationStatus] = useState<"checking" | "valid" | "invalid" | "none">("none");

  const [usageStats, setUsageStats] = useState<{
    daily_used: number;
    daily_premium_used?: number;
    standard_limit: number;
    premium_limit: number;
    remaining_standard: number;
    remaining_premium: number;
  } | null>(null);

  const WEEKLY_CHECKOUT_URL = "https://buy.stripe.com/eVq7sNa056VFbDceJs3sI02";
  const MONTHLY_CHECKOUT_URL = "https://buy.stripe.com/6oU14p3BHdk322C44O3sI01";

  const activeProvider = PROVIDERS.find(p => p.id === selectedProvider) || PROVIDERS[0];

  const fetchStatus = useCallback(async () => {
    try {
      const res: any = await invoke("get_cloud_config");
      const isCloudActive = !!res.enabled && !!res.hasToken;
      setCloudEnabled(isCloudActive);
      setHasSavedToken(!!res.hasToken);

      if (res.jwt) {
        setJwtInput(res.jwt);
      }

      if (isCloudActive) {
        setTokenVerificationStatus("checking");
        // Background status ping to check if subscription is still active in database
        setTimeout(() => {
          invoke("ask_ai", { prompt: "__status__", contextItems: [], model: "google/gemini-2.5-flash" })
            .then((rawResp: any) => {
              setTokenVerificationStatus("valid");
              const parsed = JSON.parse(rawResp.content || "{}");
              if (parsed && (parsed.standard_limit || parsed.status || parsed.daily_request_count !== undefined || parsed.daily_used !== undefined)) {
                const standard_limit = parsed.standard_limit || 300;
                const premium_limit = parsed.premium_limit || 150;
                const actualDaily = parsed.daily_used ?? parsed.daily_request_count ?? 0;
                const actualPremium = parsed.daily_premium_used ?? parsed.daily_premium_count ?? 0;
                const remaining_standard = parsed.remaining_standard !== undefined 
                    ? parsed.remaining_standard 
                    : Math.max(0, standard_limit - actualDaily);
                const remaining_premium = parsed.remaining_premium !== undefined 
                    ? parsed.remaining_premium 
                    : Math.max(0, premium_limit - actualPremium);

                setUsageStats({
                    ...parsed,
                    standard_limit,
                    premium_limit,
                    remaining_standard,
                    remaining_premium
                });
              }
            })
            .catch(err => {
              console.warn("Cloud token verification failed:", err);
              setTokenVerificationStatus("invalid");
            });
        }, 50);
      } else {
        setTokenVerificationStatus("none");
      }
    } catch (e) {
      console.error("Failed to fetch cloud config:", e);
    }
  }, []);

  useEffect(() => {
    fetchStatus();
  }, [fetchStatus]);

  useEffect(() => {
    (window as any).__refreshCloudStatus = fetchStatus;
  }, [fetchStatus]);

  const handleOpenUrl = (url: string) => {
    try {
      shellOpen(url);
    } catch {
      window.open(url, "_blank");
    }
  };

  const handleEnableCloud = async (token?: string) => {
    const activeToken = (token || jwtInput).trim();
    if (!activeToken) {
      setStatusMsg("⚠️ Please enter your Cloud License Token.");
      return;
    }

    setLoading(true);
    setStatusMsg(null);
    try {
      await invoke("set_cloud_config", {
        enabled: true,
        jwt: activeToken,
        endpoint: "https://vzuutupafqjrmfuncgxl.supabase.co/functions/v1/ai-proxy",
      });
      localStorage.setItem("hackysack_cloud_enabled", "true");
      localStorage.setItem("hackysack_cloud_jwt", encryptSecret(activeToken));
      setCloudEnabled(true);
      setHasSavedToken(true);
      setStatusMsg("☁️ HackySack Cloud Mode enabled successfully!");
      await fetchStatus();
      if (onModeChanged) onModeChanged();
    } catch (err: any) {
      setStatusMsg(`Failed to enable Cloud mode: ${err.message || err}`);
    } finally {
      setLoading(false);
    }
  };

  const handleSwitchToBYOK = async () => {
    setLoading(true);
    setStatusMsg(null);
    try {
      await invoke("set_cloud_config", {
        enabled: false,
        jwt: null,
        endpoint: null,
      });
      localStorage.setItem("hackysack_cloud_enabled", "false");
      setCloudEnabled(false);
      setStatusMsg("🔑 Switched to Bring Your Own Key (BYOK) mode.");
      await fetchStatus();
      if (onModeChanged) onModeChanged();
    } catch (err: any) {
      setStatusMsg(`Failed to switch mode: ${err.message || err}`);
    } finally {
      setLoading(false);
    }
  };

  const handleSaveByokKeys = async () => {
    if (!byokApiKey.trim()) {
      setByokStatus({ type: "error", message: "Please enter your AI API Key." });
      return;
    }

    const needsSpeechKey = ["openrouter", "anthropic", "gemini"].includes(selectedProvider);
    const hasSpeechKey = Boolean(
      transcriptionKey.trim() || 
      byokApiKey.trim().startsWith("gsk_") || 
      (byokApiKey.trim().startsWith("sk-") && !byokApiKey.trim().startsWith("sk-or-") && !byokApiKey.trim().startsWith("sk-ant-"))
    );

    if (needsSpeechKey && !hasSpeechKey) {
      setByokStatus({
        type: "error",
        message: `⚠️ ${activeProvider.name} requires a free Groq (gsk_...) or OpenAI key for speech listening.`
      });
      return;
    }

    setByokVerifying(true);
    setByokStatus(null);
    try {
      await invoke("set_api_key", {
        key: byokApiKey.trim(),
        provider: selectedProvider,
        transcriptionKey: transcriptionKey.trim() || null,
      });
      localStorage.setItem("hackysack_api_key", encryptSecret(byokApiKey.trim()));
      localStorage.setItem("hackysack_provider", selectedProvider);
      if (transcriptionKey.trim()) {
        localStorage.setItem("hackysack_transcription_key", encryptSecret(transcriptionKey.trim()));
      }
      localStorage.setItem("hackysack_cloud_enabled", "false");
      setCloudEnabled(false);
      setByokStatus({ type: "success", message: "BYOK Keys verified and saved! BYOK Mode active." });
      if (onModeChanged) onModeChanged();
    } catch (err: any) {
      setByokStatus({ type: "error", message: `Verification failed: ${err.message || err}` });
    } finally {
      setByokVerifying(false);
    }
  };

  return (
    <div
      onClick={e => {
        if (e.target === e.currentTarget) {
          onClose();
        }
      }}
      style={{
        position: "fixed",
        top: 0,
        left: 0,
        width: "100vw",
        height: "100vh",
        background: "rgba(10, 10, 18, 0.92)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 99999,
        padding: "20px",
      }}
    >
      <div
        className="animate-fadeIn"
        onClick={e => e.stopPropagation()}
        style={{
          background: "var(--bg-elevated)",
          border: "1px solid var(--border-bright)",
          borderRadius: "var(--radius-xl)",
          width: "520px",
          maxWidth: "95vw",
          boxShadow: "0 24px 60px rgba(0, 0, 0, 0.6)",
          overflow: "hidden",
        }}
      >
        {/* Header */}
        <div
          data-tauri-drag-region
          style={{
            padding: "18px 24px",
            borderBottom: "1px solid var(--border)",
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            cursor: "grab",
          }}
        >
          <div data-tauri-drag-region style={{ display: "flex", alignItems: "center", gap: "10px" }}>
            <div
              style={{
                width: 36,
                height: 36,
                borderRadius: "10px",
                background: "linear-gradient(135deg, #6366f1, #a855f7)",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                color: "#fff",
                pointerEvents: "none",
              }}
            >
              <Cloud size={20} />
            </div>
            <div data-tauri-drag-region>
              <h2 data-tauri-drag-region style={{ fontSize: "16px", fontWeight: 700, color: "var(--text-primary)", margin: 0 }}>AI Mode &amp; Account Settings</h2>
              <p data-tauri-drag-region style={{ fontSize: "11px", color: "var(--text-muted)", margin: 0 }}>
                {cloudEnabled ? "☁️ HackySack Managed Cloud Active" : "🔑 Bring Your Own Key (BYOK) Active"}
              </p>
            </div>
          </div>
          <button className="btn btn-ghost" style={{ padding: "4px 8px" }} onClick={onClose}>
            <X size={16} />
          </button>
        </div>

        {/* Tab Selection */}
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", padding: "12px 24px 0", gap: "8px" }}>
          <button
            onClick={() => setActiveTab("cloud")}
            style={{
              padding: "10px",
              borderRadius: "var(--radius-md)",
              border: activeTab === "cloud" ? "1.5px solid var(--accent-start)" : "1px solid var(--border)",
              background: activeTab === "cloud" ? "rgba(99, 102, 241, 0.12)" : "transparent",
              color: activeTab === "cloud" ? "var(--text-primary)" : "var(--text-muted)",
              fontWeight: 600,
              fontSize: "12px",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              gap: "6px",
              cursor: "pointer",
            }}
          >
            <Cloud size={14} /> HackySack Cloud Managed
          </button>
          <button
            onClick={() => setActiveTab("byok")}
            style={{
              padding: "10px",
              borderRadius: "var(--radius-md)",
              border: activeTab === "byok" ? "1.5px solid var(--accent-start)" : "1px solid var(--border)",
              background: activeTab === "byok" ? "rgba(99, 102, 241, 0.12)" : "transparent",
              color: activeTab === "byok" ? "var(--text-primary)" : "var(--text-muted)",
              fontWeight: 600,
              fontSize: "12px",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              gap: "6px",
              cursor: "pointer",
            }}
          >
            <Key size={14} /> BYOK Free Mode
          </button>
        </div>

        {/* Body */}
        <div style={{ padding: "20px 24px", maxHeight: "75vh", overflowY: "auto" }}>
          {activeTab === "cloud" ? (
            <div>
              {/* Celebration Banner if just activated or token ready */}
              {(!cloudEnabled && (hasSavedToken || jwtInput.trim())) && (
                <div
                  style={{
                    background: "linear-gradient(135deg, rgba(16, 185, 129, 0.15), rgba(5, 150, 105, 0.15))",
                    border: "1.5px solid rgba(16, 185, 129, 0.5)",
                    borderRadius: "var(--radius-lg)",
                    padding: "14px 16px",
                    marginBottom: "16px",
                    boxShadow: "0 4px 20px rgba(16, 185, 129, 0.2)",
                  }}
                >
                  <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: "6px" }}>
                    <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                      <Sparkles size={16} color="#10b981" />
                      <span style={{ fontSize: "13px", fontWeight: 700, color: "#ffffff" }}>Active Cloud Token Found</span>
                    </div>
                    <span style={{ fontSize: "10px", fontWeight: 700, color: "#10b981", background: "rgba(16, 185, 129, 0.2)", border: "1px solid rgba(16, 185, 129, 0.4)", padding: "2px 8px", borderRadius: "10px" }}>Ready to Activate</span>
                  </div>
                  <p style={{ fontSize: "11px", color: "var(--text-secondary)", margin: "0 0 12px 0", lineHeight: 1.4 }}>
                    Your subscription token is saved. Click below to instantly activate Cloud Mode.
                  </p>
                  <button
                    className="btn btn-primary"
                    style={{
                      width: "100%",
                      justifyContent: "center",
                      padding: "10px",
                      fontSize: "12px",
                      fontWeight: 700,
                      gap: "6px",
                      background: "linear-gradient(135deg, #10b981, #059669)",
                      color: "#ffffff",
                      border: "none",
                      boxShadow: "0 4px 15px rgba(16, 185, 129, 0.35)",
                    }}
                    onClick={() => handleEnableCloud(jwtInput.trim() || undefined)}
                    disabled={loading}
                  >
                    <Cloud size={14} /> 🚀 Switch to Cloud Pass Mode
                  </button>
                </div>
              )}

              {/* If Cloud Mode Active & Token Verified */}
              {cloudEnabled && tokenVerificationStatus === "invalid" ? (
                <div>
                  <div
                    style={{
                      background: "linear-gradient(135deg, rgba(239, 68, 68, 0.15), rgba(185, 28, 28, 0.15))",
                      border: "1.5px solid rgba(239, 68, 68, 0.5)",
                      borderRadius: "var(--radius-lg)",
                      padding: "16px",
                      marginBottom: "16px",
                    }}
                  >
                    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: "8px" }}>
                      <span style={{ fontSize: "13px", fontWeight: 700, color: "#fca5a5", display: "flex", alignItems: "center", gap: "6px" }}>
                        <AlertTriangle size={16} color="#ef4444" /> Cloud Pass Inactive or Expired
                      </span>
                      <span style={{ fontSize: "10px", fontWeight: 700, color: "#ef4444", background: "rgba(239, 68, 68, 0.2)", padding: "2px 8px", borderRadius: "10px" }}>
                        Inactive
                      </span>
                    </div>
                    <p style={{ fontSize: "11.5px", color: "var(--text-secondary)", margin: "0 0 12px 0", lineHeight: 1.5 }}>
                      Your subscription token is no longer active in our database (it may have expired, been cancelled, or removed). Please renew your pass below or switch to Free BYOK mode.
                    </p>
                    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "8px" }}>
                      <button
                        className="btn btn-primary"
                        style={{ fontSize: "11px", padding: "8px", justifyContent: "center" }}
                        onClick={() => handleOpenUrl(WEEKLY_CHECKOUT_URL)}
                      >
                        Renew Sprint Pass ($19.99)
                      </button>
                      <button
                        className="btn btn-secondary"
                        style={{ fontSize: "11px", padding: "8px", justifyContent: "center" }}
                        onClick={() => handleSwitchToBYOK()}
                      >
                        Switch to BYOK Free Mode
                      </button>
                    </div>
                  </div>
                </div>
              ) : cloudEnabled ? (
                <div>
                  <div
                    style={{
                      background: "linear-gradient(135deg, rgba(16, 185, 129, 0.12), rgba(99, 102, 241, 0.12))",
                      border: "1.5px solid rgba(16, 185, 129, 0.4)",
                      borderRadius: "var(--radius-lg)",
                      padding: "16px",
                      marginBottom: "16px",
                    }}
                  >
                    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: "12px" }}>
                      <span style={{ fontSize: "13px", fontWeight: 700, color: "#fff", display: "flex", alignItems: "center", gap: "6px" }}>
                        <CheckCircle2 size={16} color="#10b981" /> Cloud Pass Active — Thank You for Subscribing! 🎉
                      </span>
                      <span style={{ fontSize: "10px", fontWeight: 700, color: "#10b981", background: "rgba(16, 185, 129, 0.15)", padding: "2px 8px", borderRadius: "10px" }}>
                        Active Pass
                      </span>
                    </div>

                    <div style={{ background: "rgba(0, 0, 0, 0.25)", borderRadius: "var(--radius-md)", padding: "12px", border: "1px solid rgba(255, 255, 255, 0.05)", display: "flex", flexDirection: "column", gap: "12px" }}>
                      {/* Standard Credits (Llama 3.3 / DeepSeek V3) */}
                      <div>
                        <div style={{ display: "flex", justifyContent: "space-between", fontSize: "11px", marginBottom: "4px" }}>
                          <span style={{ color: "var(--text-secondary)" }}>⚡ Standard AI Credits (Llama 3.3 / DeepSeek V3):</span>
                          <span style={{ fontWeight: 700, color: "#10b981" }}>
                            {usageStats ? `${usageStats.remaining_standard} / ${usageStats.standard_limit || 300} Today` : "300 / 300 Today"}
                          </span>
                        </div>
                        <div style={{ width: "100%", height: "6px", background: "rgba(255, 255, 255, 0.1)", borderRadius: "3px", overflow: "hidden" }}>
                          <div style={{ width: `${usageStats ? Math.min(100, Math.max(0, (usageStats.remaining_standard / (usageStats.standard_limit || 300)) * 100)) : 100}%`, height: "100%", background: "#10b981", transition: "width 0.3s ease" }} />
                        </div>
                      </div>

                      {/* Premium Credits (Claude 3.5 Sonnet / GPT-4o) */}
                      <div>
                        <div style={{ display: "flex", justifyContent: "space-between", fontSize: "11px", marginBottom: "4px" }}>
                          <span style={{ color: "var(--text-secondary)" }}>👑 Premium AI Credits (Claude 3.5 Sonnet / GPT-4o):</span>
                          <span style={{ fontWeight: 700, color: "#a855f7" }}>
                            {usageStats ? `${usageStats.remaining_premium} / ${usageStats.premium_limit || 150} Today` : "150 / 150 Today"}
                          </span>
                        </div>
                        <div style={{ width: "100%", height: "6px", background: "rgba(255, 255, 255, 0.1)", borderRadius: "3px", overflow: "hidden" }}>
                          <div style={{ width: `${usageStats ? Math.min(100, Math.max(0, (usageStats.remaining_premium / (usageStats.premium_limit || 150)) * 100)) : 100}%`, height: "100%", background: "#a855f7", transition: "width 0.3s ease" }} />
                        </div>
                      </div>
                    </div>
                  </div>

                  <div style={{ display: "flex", gap: "10px", justifyContent: "center" }}>
                    <button
                      className="btn btn-secondary"
                      style={{ fontSize: "11px", padding: "8px 16px", fontWeight: 600, width: "100%", justifyContent: "center" }}
                      onClick={() => handleSwitchToBYOK()}
                    >
                      Switch to BYOK Free Mode
                    </button>
                  </div>
                </div>
              ) : (
                <div>
                  <div
                    style={{
                      background: "linear-gradient(135deg, rgba(99, 102, 241, 0.12), rgba(168, 85, 247, 0.08))",
                      border: "1px solid rgba(99, 102, 241, 0.3)",
                      borderRadius: "var(--radius-lg)",
                      padding: "16px",
                      marginBottom: "16px",
                    }}
                  >
                    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: "8px" }}>
                      <span style={{ fontSize: "14px", fontWeight: 700, color: "#fff", display: "flex", alignItems: "center", gap: "6px" }}>
                        <Sparkles size={16} color="#a855f7" /> Zero-Setup Cloud AI Pass
                      </span>
                      <span style={{ fontSize: "11px", fontWeight: 700, background: "#10b981", color: "#fff", padding: "2px 8px", borderRadius: "12px" }}>
                        Save 60% vs Competitors
                      </span>
                    </div>
                    <ul style={{ fontSize: "11px", color: "var(--text-secondary)", margin: 0, paddingLeft: "18px", lineHeight: 1.6 }}>
                      <li>Instant zero-setup access to Claude 3.5 Sonnet, DeepSeek V3, &amp; Llama 3.3 70B</li>
                      <li>Real-time audio transcription (No API keys needed)</li>
                      <li>Ultra-fast streaming &amp; priority uptime proxy</li>
                    </ul>
                  </div>

                  {/* Pricing Cards */}
                  <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "10px", marginBottom: "16px" }}>
                    <div
                      style={{
                        background: "rgba(255, 255, 255, 0.03)",
                        border: "1px solid var(--border)",
                        borderRadius: "var(--radius-md)",
                        padding: "12px",
                        display: "flex",
                        flexDirection: "column",
                        justifyContent: "space-between",
                      }}
                    >
                      <div>
                        <span style={{ fontSize: "11px", fontWeight: 700, color: "var(--text-muted)", textTransform: "uppercase" }}>7-Day Sprint Pass</span>
                        <div style={{ fontSize: "20px", fontWeight: 800, color: "#fff", margin: "4px 0" }}>$19.99 <span style={{ fontSize: "11px", fontWeight: 400, color: "var(--text-muted)" }}>/ week</span></div>
                        <p style={{ fontSize: "10px", color: "var(--text-secondary)", margin: 0 }}>Perfect for an interview coming up this week.</p>
                      </div>
                      <button
                        className="btn btn-secondary"
                        style={{ width: "100%", justifyContent: "center", fontSize: "11px", marginTop: "12px", padding: "8px", fontWeight: 600, gap: "4px" }}
                        onClick={() => handleOpenUrl(WEEKLY_CHECKOUT_URL)}
                      >
                        Get 7-Day Pass <ExternalLink size={12} />
                      </button>
                    </div>

                    <div
                      style={{
                        background: "rgba(99, 102, 241, 0.08)",
                        border: "1.5px solid var(--accent-start)",
                        borderRadius: "var(--radius-md)",
                        padding: "12px",
                        display: "flex",
                        flexDirection: "column",
                        justifyContent: "space-between",
                        position: "relative",
                      }}
                    >
                      <span style={{ position: "absolute", top: "-8px", right: "10px", background: "linear-gradient(135deg, #6366f1, #a855f7)", color: "#fff", fontSize: "9px", fontWeight: 700, padding: "2px 6px", borderRadius: "4px" }}>POPULAR</span>
                      <div>
                        <span style={{ fontSize: "11px", fontWeight: 700, color: "var(--accent-start)", textTransform: "uppercase" }}>Pro Monthly Pass</span>
                        <div style={{ fontSize: "20px", fontWeight: 800, color: "#fff", margin: "4px 0" }}>$29.99 <span style={{ fontSize: "11px", fontWeight: 400, color: "var(--text-muted)" }}>/ month</span></div>
                        <p style={{ fontSize: "10px", color: "var(--text-secondary)", margin: 0 }}>Unlimited access for active job hunters.</p>
                      </div>
                      <button
                        className="btn btn-primary"
                        style={{ width: "100%", justifyContent: "center", fontSize: "11px", marginTop: "12px", padding: "8px", fontWeight: 700, gap: "4px" }}
                        onClick={() => handleOpenUrl(MONTHLY_CHECKOUT_URL)}
                      >
                        <Zap size={12} /> Get Pro Pass <ExternalLink size={12} />
                      </button>
                    </div>
                  </div>

                  {/* Token Paste Input */}
                  <div style={{ borderTop: "1px solid var(--border)", paddingTop: "14px" }}>
                    <label style={{ fontSize: "11px", fontWeight: 600, color: "var(--text-primary)", display: "block", marginBottom: "6px" }}>
                      Already have an active pass? Paste your Cloud Access Token:
                    </label>
                    <div style={{ display: "flex", gap: "8px" }}>
                      <input
                        type="password"
                        className="input"
                        placeholder="Paste Cloud Access Token (hs_cloud_...)"
                        value={jwtInput}
                        onChange={e => setJwtInput(e.target.value)}
                        style={{ flex: 1, fontSize: "11px" }}
                      />
                      <button
                        className="btn btn-secondary"
                        style={{ fontSize: "11px", padding: "6px 14px", fontWeight: 600 }}
                        onClick={() => handleEnableCloud()}
                        disabled={loading}
                      >
                        Activate
                      </button>
                    </div>
                  </div>
                </div>
              )}
            </div>
          ) : (
            /* BYOK TAB: SLEEK COMPACT KEY CONFIGURATION FORM */
            <div>
              {/* Active Mode Status Indicator */}
              <div
                style={{
                  background: !cloudEnabled ? "rgba(16, 185, 129, 0.08)" : "rgba(255, 255, 255, 0.03)",
                  border: `1px solid ${!cloudEnabled ? "rgba(16, 185, 129, 0.3)" : "var(--border)"}`,
                  borderRadius: "var(--radius-md)",
                  padding: "10px 14px",
                  marginBottom: "14px",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                }}
              >
                <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                  <ShieldCheck size={16} color={!cloudEnabled ? "#10b981" : "var(--text-muted)"} />
                  <span style={{ fontSize: "12px", fontWeight: 700, color: "#ffffff" }}>
                    {!cloudEnabled ? "BYOK Free Mode Active" : "Currently in Cloud Pass Mode"}
                  </span>
                </div>
                {cloudEnabled && (
                  <button
                    className="btn btn-secondary"
                    style={{ fontSize: "10px", padding: "3px 8px", fontWeight: 600 }}
                    onClick={handleSwitchToBYOK}
                    disabled={loading}
                  >
                    Switch to BYOK Mode
                  </button>
                )}
              </div>

              {/* Step 1: Compact Provider Dropdown + Get Key Button */}
              <label style={{ fontSize: "11px", fontWeight: 700, color: "var(--text-secondary)", textTransform: "uppercase", letterSpacing: "0.5px", marginBottom: "6px", display: "block" }}>
                Select AI Provider
              </label>
              <div style={{ display: "flex", gap: "8px", marginBottom: "10px" }}>
                <div style={{ position: "relative", flex: 1 }}>
                  <select
                    className="input"
                    value={selectedProvider}
                    onChange={e => setSelectedProvider(e.target.value)}
                    style={{
                      width: "100%",
                      padding: "8px 32px 8px 12px",
                      fontSize: "12px",
                      fontWeight: 600,
                      background: "rgba(255, 255, 255, 0.05)",
                      border: "1px solid var(--border-bright)",
                      borderRadius: "var(--radius-md)",
                      color: "#ffffff",
                      appearance: "none",
                      cursor: "pointer",
                    }}
                  >
                    {PROVIDERS.map(p => (
                      <option key={p.id} value={p.id} style={{ background: "#1e1e2e", color: "#fff" }}>
                        {p.name} ({p.badge})
                      </option>
                    ))}
                  </select>
                  <ChevronDown size={14} style={{ position: "absolute", right: 10, top: "50%", transform: "translateY(-50%)", pointerEvents: "none", color: "var(--text-muted)" }} />
                </div>
                <button
                  className="btn btn-secondary"
                  style={{ fontSize: "11px", padding: "8px 12px", gap: "4px", whiteSpace: "nowrap", fontWeight: 600 }}
                  onClick={() => handleOpenUrl(activeProvider.keyUrl)}
                >
                  <ExternalLink size={12} /> {activeProvider.urlLabel}
                </button>
              </div>

              <p style={{ fontSize: "11px", color: "var(--text-muted)", margin: "0 0 12px 0", lineHeight: 1.4 }}>
                {activeProvider.instruction}
              </p>

              {/* Step 2: Main API Key */}
              <label style={{ fontSize: "11px", fontWeight: 700, color: "var(--text-secondary)", textTransform: "uppercase", letterSpacing: "0.5px", marginBottom: "6px", display: "block" }}>
                Main AI API Key
              </label>
              <input
                type="password"
                className="input"
                placeholder={`Paste ${activeProvider.name} Key (${activeProvider.keyPrefix})`}
                value={byokApiKey}
                onChange={e => setByokApiKey(e.target.value)}
                style={{ width: "100%", marginBottom: "12px", fontSize: "12px" }}
              />

              {/* Voice / Speech Transcription Key */}
              {["openrouter", "anthropic", "gemini"].includes(selectedProvider) && (
                <div style={{ marginBottom: "14px", padding: "10px 12px", borderRadius: "var(--radius-md)", background: "rgba(16, 185, 129, 0.06)", border: "1px solid rgba(16, 185, 129, 0.2)" }}>
                  <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: "4px" }}>
                    <span style={{ fontSize: "11px", fontWeight: 700, color: "#10b981" }}>🎙️ Voice / Speech Key (Required for Live Audio)</span>
                    <button
                      className="btn btn-ghost"
                      style={{ fontSize: "10px", padding: "2px 6px", color: "#10b981", gap: "3px" }}
                      onClick={() => handleOpenUrl("https://console.groq.com/keys")}
                    >
                      <ExternalLink size={10} /> Get Free Groq Key
                    </button>
                  </div>
                  <p style={{ fontSize: "10px", color: "var(--text-muted)", margin: "0 0 6px 0", lineHeight: 1.35 }}>
                    Converts live speech to text. Groq is <strong>100% Free</strong>. Paste your Groq (<code>gsk_...</code>) key below.
                  </p>
                  <input
                    type="password"
                    className="input"
                    placeholder="gsk_... (Free Groq speech transcription key)"
                    value={transcriptionKey}
                    onChange={e => setTranscriptionKey(e.target.value)}
                    style={{ width: "100%", fontSize: "11px" }}
                  />
                </div>
              )}

              {byokStatus && (
                <div style={{ padding: "8px 12px", borderRadius: "var(--radius-md)", background: byokStatus.type === "success" ? "rgba(16, 185, 129, 0.12)" : "rgba(239, 68, 68, 0.12)", border: `1px solid ${byokStatus.type === "success" ? "rgba(16, 185, 129, 0.3)" : "rgba(239, 68, 68, 0.3)"}`, color: byokStatus.type === "success" ? "#10b981" : "#ef4444", fontSize: "11px", marginBottom: "12px" }}>
                  {byokStatus.message}
                </div>
              )}

              <button
                className="btn btn-primary"
                style={{ width: "100%", justifyContent: "center", padding: "10px", fontSize: "12px", fontWeight: 700, gap: "6px" }}
                onClick={handleSaveByokKeys}
                disabled={byokVerifying || !byokApiKey.trim()}
              >
                {byokVerifying ? "Verifying Keys..." : <><Check size={14} /> Save BYOK Keys &amp; Activate Free Mode</>}
              </button>
            </div>
          )}

          {statusMsg && (
            <div
              style={{
                marginTop: "14px",
                padding: "8px 12px",
                borderRadius: "var(--radius-md)",
                background: statusMsg.includes("Failed") || statusMsg.includes("⚠️") ? "rgba(239,68,68,0.12)" : "rgba(16,185,129,0.12)",
                border: `1px solid ${statusMsg.includes("Failed") || statusMsg.includes("⚠️") ? "rgba(239,68,68,0.3)" : "rgba(16,185,129,0.3)"}`,
                color: statusMsg.includes("Failed") || statusMsg.includes("⚠️") ? "#ef4444" : "#10b981",
                fontSize: "11px",
              }}
            >
              {statusMsg}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
