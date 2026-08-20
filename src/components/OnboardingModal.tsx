import { useState } from "react";
import { Check, ExternalLink, Sparkles, X, ChevronDown, Zap, Cloud } from "lucide-react";
import { open as shellOpen } from "@tauri-apps/plugin-shell";
import { invoke } from "@tauri-apps/api/core";
import { useTauri } from "../hooks/useTauri";
import { encryptSecret } from "../utils/crypto";

interface OnboardingModalProps {
  onClose: () => void;
  onComplete: (key: string, provider: string, transKey?: string) => Promise<void>;
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
  desc: string;
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
    instruction: "Free & paid access to Claude 3.7 Sonnet, DeepSeek V3/R1, Llama 3.3 70B & GPT-4o.",
    desc: "Free & paid key for all top AI models.",
  },
  {
    id: "groq",
    name: "Groq AI",
    badge: "100% FREE",
    badgeColor: "linear-gradient(135deg, #10b981, #059669)",
    keyUrl: "https://console.groq.com/keys",
    urlLabel: "Get Free Groq Key",
    keyPrefix: "gsk_...",
    instruction: "100% free forever. Delivers ultra-fast Llama 3.3 70B responses & speech listening.",
    desc: "100% Free AI answers & voice transcription.",
  },
  {
    id: "openai",
    name: "OpenAI",
    badge: "PAID",
    badgeColor: "#3b82f6",
    keyUrl: "https://platform.openai.com/api-keys",
    urlLabel: "Get OpenAI Key",
    keyPrefix: "sk-...",
    instruction: "Official API key for GPT-4o, GPT-4.5 & Whisper real-time audio transcription.",
    desc: "GPT-4o & Whisper audio support.",
  },
  {
    id: "anthropic",
    name: "Anthropic",
    badge: "PAID",
    badgeColor: "#d97706",
    keyUrl: "https://console.anthropic.com/settings/keys",
    urlLabel: "Get Anthropic Key",
    keyPrefix: "sk-ant-...",
    instruction: "Official API key for Claude 3.7 Sonnet & Claude 3.5 Haiku.",
    desc: "Claude 3.7 Sonnet direct API.",
  },
  {
    id: "gemini",
    name: "Google Gemini",
    badge: "FREE / PAID",
    badgeColor: "#ec4899",
    keyUrl: "https://aistudio.google.com/app/apikey",
    urlLabel: "Get Gemini Key",
    keyPrefix: "AIza...",
    instruction: "Official Google AI Studio API key for Gemini 3.7 Flash.",
    desc: "Google AI Studio Gemini access.",
  },
];

const WEEKLY_CHECKOUT_URL = "https://buy.stripe.com/eVq7sNa056VFbDceJs3sI02";
const MONTHLY_CHECKOUT_URL = "https://buy.stripe.com/6oU14p3BHdk322C44O3sI01";

export function OnboardingModal({ onClose, onComplete }: OnboardingModalProps) {
  const { ping } = useTauri();
  const [selectedProvider, setSelectedProvider] = useState<string>("openrouter");
  const [apiKey, setApiKey] = useState("");
  const [transcriptionKey, setTranscriptionKey] = useState("");
  const [verifying, setVerifying] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const activeProvider = PROVIDERS.find(p => p.id === selectedProvider) || PROVIDERS[0];

  const handleOpenUrl = (url: string) => {
    try {
      shellOpen(url);
    } catch {
      window.open(url, "_blank");
    }
  };

  const handleVerifyAndSave = async () => {
    if (!apiKey.trim()) {
      setErrorMsg("Please enter your API key or Cloud Pass token.");
      return;
    }

    // Direct Cloud Pass token activation
    if (apiKey.trim().startsWith("hs_")) {
      setVerifying(true);
      setErrorMsg(null);
      try {
        await invoke("set_cloud_config", {
          enabled: true,
          jwt: apiKey.trim(),
          endpoint: "https://vzuutupafqjrmfuncgxl.supabase.co/functions/v1/ai-proxy",
        });
        localStorage.setItem("hackysack_cloud_enabled", "true");
        localStorage.setItem("hackysack_cloud_jwt", encryptSecret(apiKey.trim()));
        if ((window as any).__refreshCloudStatus) {
          try { (window as any).__refreshCloudStatus(); } catch (_) {}
        }
        onClose();
      } catch (err: any) {
        setErrorMsg(`Failed to activate Cloud Token: ${err.message || err}`);
      } finally {
        setVerifying(false);
      }
      return;
    }

    const needsSpeechKey = ["openrouter", "anthropic", "gemini"].includes(selectedProvider);
    const hasSpeechKey = Boolean(
      transcriptionKey.trim() || 
      apiKey.trim().startsWith("gsk_") || 
      (apiKey.trim().startsWith("sk-") && !apiKey.trim().startsWith("sk-or-") && !apiKey.trim().startsWith("sk-ant-"))
    );

    if (needsSpeechKey && !hasSpeechKey) {
      setErrorMsg(`⚠️ ${activeProvider.name} requires a free Groq (gsk_...) or OpenAI key below for live microphone & audio listening.`);
      return;
    }

    setVerifying(true);
    setErrorMsg(null);

    try {
      await onComplete(apiKey.trim(), selectedProvider, transcriptionKey.trim() || undefined);
      const res = await ping("Test connection");
      if (res && res.toLowerCase().includes("ok")) {
        onClose();
      } else {
        setErrorMsg(`API Key saved, but test ping returned: ${res || "no response"}. Check your key credit.`);
        setTimeout(onClose, 2500);
      }
    } catch (err: any) {
      setErrorMsg(`Failed to save key: ${err.message || err}`);
    } finally {
      setVerifying(false);
    }
  };

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(10, 10, 18, 0.90)",
        backdropFilter: "blur(8px)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 99999,
        padding: "16px",
      }}
    >
      <div
        className="animate-fadeIn"
        style={{
          background: "var(--bg-elevated)",
          border: "1px solid var(--border-bright)",
          borderRadius: "16px",
          width: "480px",
          maxWidth: "95vw",
          boxShadow: "0 24px 60px rgba(0, 0, 0, 0.65)",
          overflow: "hidden",
        }}
      >
        {/* Header */}
        <div data-tauri-drag-region style={{ padding: "16px 20px", borderBottom: "1px solid var(--border)", display: "flex", alignItems: "center", justifyContent: "space-between", cursor: "grab" }}>
          <div data-tauri-drag-region style={{ display: "flex", alignItems: "center", gap: "10px" }}>
            <div style={{ width: 32, height: 32, borderRadius: "8px", background: "linear-gradient(135deg, var(--accent-start), var(--accent-end))", display: "flex", alignItems: "center", justifyContent: "center", color: "#fff", pointerEvents: "none" }}>
              <Sparkles size={18} />
            </div>
            <div data-tauri-drag-region>
              <h2 data-tauri-drag-region style={{ fontSize: "15px", fontWeight: 700, color: "var(--text-primary)", margin: 0 }}>HackySack AI Setup</h2>
              <p data-tauri-drag-region style={{ fontSize: "11px", color: "var(--text-muted)", margin: 0 }}>Free BYOK or 1-Click Zero Setup Cloud Pass</p>
            </div>
          </div>
          <button className="btn btn-ghost" style={{ padding: "4px 8px" }} onClick={onClose}>
            <X size={16} />
          </button>
        </div>

        {/* Body */}
        <div style={{ padding: "18px 20px", maxHeight: "80vh", overflowY: "auto" }}>
          {/* Cloud Pass Zero-Setup Option Banner */}
          <div
            style={{
              background: "linear-gradient(135deg, rgba(99, 102, 241, 0.16), rgba(168, 85, 247, 0.12))",
              border: "1.5px solid rgba(168, 85, 247, 0.4)",
              borderRadius: "var(--radius-lg)",
              padding: "12px 14px",
              marginBottom: "16px",
              display: "flex",
              flexDirection: "column",
              gap: "8px",
            }}
          >
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
              <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
                <Cloud size={15} style={{ color: "#a855f7" }} />
                <span style={{ fontSize: "12.5px", fontWeight: 700, color: "#ffffff" }}>
                  Zero-Setup Cloud Pass
                </span>
              </div>
              <span style={{ fontSize: "9px", fontWeight: 700, background: "#10b981", color: "#ffffff", padding: "2px 7px", borderRadius: "8px" }}>
                NO API KEYS NEEDED
              </span>
            </div>
            <p style={{ fontSize: "11px", color: "var(--text-secondary)", margin: 0, lineHeight: 1.4 }}>
              Don't want to deal with developer API keys? Get instant pre-configured access to Claude 3.7 Sonnet, GPT-4.5, and real-time speech transcription.
            </p>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "8px", marginTop: "2px" }}>
              <button
                className="btn btn-primary"
                style={{ fontSize: "11px", padding: "7px 10px", justifyContent: "center", gap: "4px", fontWeight: 700 }}
                onClick={() => handleOpenUrl(WEEKLY_CHECKOUT_URL)}
              >
                <Zap size={11} /> 7-Day Pass ($19.99) <ExternalLink size={11} />
              </button>
              <button
                className="btn btn-secondary"
                style={{ fontSize: "11px", padding: "7px 10px", justifyContent: "center", gap: "4px", fontWeight: 600 }}
                onClick={() => handleOpenUrl(MONTHLY_CHECKOUT_URL)}
              >
                Pro Month ($29.99) <ExternalLink size={11} />
              </button>
            </div>
          </div>

          {/* Divider */}
          <div style={{ display: "flex", alignItems: "center", margin: "14px 0", gap: "10px" }}>
            <div style={{ flex: 1, height: "1px", background: "var(--border)" }} />
            <span style={{ fontSize: "10px", fontWeight: 700, color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: "0.5px" }}>
              Or Bring Your Own Key (100% Free)
            </span>
            <div style={{ flex: 1, height: "1px", background: "var(--border)" }} />
          </div>

          {/* Step 1 & 2: Provider Selector Dropdown + Get Key Button */}
          <label style={{ fontSize: "11px", fontWeight: 700, color: "var(--text-secondary)", textTransform: "uppercase", letterSpacing: "0.5px", marginBottom: "6px", display: "block" }}>
            1. Select AI Provider
          </label>
          <div style={{ display: "flex", gap: "8px", marginBottom: "12px" }}>
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

          {/* Provider Detail Card */}
          <div style={{ background: "rgba(99, 102, 241, 0.06)", border: "1px solid rgba(99, 102, 241, 0.2)", borderRadius: "var(--radius-md)", padding: "10px 12px", marginBottom: "14px" }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: "4px" }}>
              <span style={{ fontSize: "12px", fontWeight: 700, color: "var(--text-primary)" }}>{activeProvider.name}</span>
              <span style={{ fontSize: "9px", fontWeight: 700, padding: "2px 6px", borderRadius: "4px", background: activeProvider.badgeColor, color: "#fff" }}>
                {activeProvider.badge}
              </span>
            </div>
            <p style={{ fontSize: "11px", color: "var(--text-muted)", margin: 0, lineHeight: 1.4 }}>
              {activeProvider.instruction}
            </p>
          </div>

          {/* Step 3: Main API Key */}
          <label style={{ fontSize: "11px", fontWeight: 700, color: "var(--text-secondary)", textTransform: "uppercase", letterSpacing: "0.5px", marginBottom: "6px", display: "block" }}>
            2. Main AI API Key
          </label>
          <input
            type="password"
            className="input"
            placeholder={`Paste ${activeProvider.name} Key (${activeProvider.keyPrefix})`}
            value={apiKey}
            onChange={e => setApiKey(e.target.value)}
            onKeyDown={e => { if (e.key === "Enter") handleVerifyAndSave(); }}
            style={{ width: "100%", marginBottom: "12px", fontSize: "12px" }}
          />

          {/* Optional Voice Transcription Key */}
          {["openrouter", "anthropic", "gemini"].includes(selectedProvider) && (
            <div style={{ marginBottom: "14px", padding: "10px 12px", borderRadius: "var(--radius-md)", background: "rgba(16, 185, 129, 0.06)", border: "1px solid rgba(16, 185, 129, 0.2)" }}>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: "4px" }}>
                <span style={{ fontSize: "11px", fontWeight: 700, color: "#10b981" }}>🎙️ Voice / Speech Key (Required for Audio)</span>
                <button
                  className="btn btn-ghost"
                  style={{ fontSize: "10px", padding: "2px 6px", color: "#10b981", gap: "3px" }}
                  onClick={() => handleOpenUrl("https://console.groq.com/keys")}
                >
                  <ExternalLink size={10} /> Get Free Groq Key
                </button>
              </div>
              <p style={{ fontSize: "10px", color: "var(--text-muted)", margin: "0 0 6px 0", lineHeight: 1.35 }}>
                Converts live speech to text in real-time. Groq is <strong>100% Free</strong>. Paste your Groq (<code>gsk_...</code>) key below.
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

          {errorMsg && (
            <div style={{ padding: "8px 12px", borderRadius: "var(--radius-md)", background: "rgba(239, 68, 68, 0.12)", border: "1px solid rgba(239, 68, 68, 0.3)", color: "#ef4444", fontSize: "11px", marginBottom: "12px" }}>
              {errorMsg}
            </div>
          )}

          <div style={{ marginBottom: "14px", padding: "6px 10px", borderRadius: "var(--radius-md)", background: "rgba(255, 255, 255, 0.03)", border: "1px solid var(--border)", color: "var(--text-muted)", fontSize: "10px", display: "flex", alignItems: "center", gap: "6px" }}>
            <span>💡</span>
            <span>Press <code style={{ color: "#a855f7", fontWeight: 700 }}>Ctrl + Shift + H</code> anytime to show or hide HackySack.</span>
          </div>

          <button
            className="btn btn-primary"
            style={{ width: "100%", justifyContent: "center", padding: "10px", fontSize: "13px", fontWeight: 700, gap: "6px" }}
            onClick={handleVerifyAndSave}
            disabled={!apiKey.trim() || verifying}
          >
            {verifying ? (
              "Verifying Connection..."
            ) : (
              <>
                <Check size={16} /> Verify &amp; Start HackySack
              </>
            )}
          </button>
        </div>
      </div>
    </div>
  );
}
