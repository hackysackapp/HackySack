import React from "react";
import { AlertTriangle, Cloud, Key, ExternalLink, X, RefreshCw } from "lucide-react";
import { open as shellOpen } from "@tauri-apps/plugin-shell";
import { invoke } from "@tauri-apps/api/core";

interface CloudExpiredModalProps {
  onClose: () => void;
  onSwitchToBYOK: () => void;
}

const WEEKLY_CHECKOUT_URL = "https://buy.stripe.com/eVq7sNa056VFbDceJs3sI02";
const MONTHLY_CHECKOUT_URL = "https://buy.stripe.com/6oU14p3BHdk322C44O3sI01";

export function CloudExpiredModal({ onClose, onSwitchToBYOK }: CloudExpiredModalProps) {
  const handleOpenCheckout = (url: string) => {
    try {
      shellOpen(url);
    } catch {
      window.open(url, "_blank");
    }
  };

  return (
    <div
      style={{
        position: "fixed",
        top: 0,
        left: 0,
        width: "100vw",
        height: "100vh",
        background: "rgba(10, 10, 18, 0.88)",
        backdropFilter: "blur(8px)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 999999,
        padding: "20px",
      }}
      onClick={onClose}
    >
      <div
        className="animate-fadeIn glass-panel"
        onClick={e => e.stopPropagation()}
        style={{
          background: "#121420",
          border: "1px solid rgba(239, 68, 68, 0.4)",
          borderRadius: "16px",
          width: "480px",
          maxWidth: "92vw",
          padding: "24px",
          boxShadow: "0 20px 50px rgba(0, 0, 0, 0.8), 0 0 30px rgba(239, 68, 68, 0.15)",
          color: "#f3f4f6",
        }}
      >
        {/* Header */}
        <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", marginBottom: "16px" }}>
          <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
            <div
              style={{
                width: "38px",
                height: "38px",
                borderRadius: "10px",
                background: "rgba(239, 68, 68, 0.15)",
                border: "1px solid rgba(239, 68, 68, 0.4)",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                color: "#ef4444",
                flexShrink: 0,
              }}
            >
              <AlertTriangle size={20} />
            </div>
            <div>
              <h3 style={{ fontSize: "15px", fontWeight: 700, margin: 0, color: "#ffffff" }}>
                Cloud Subscription Inactive
              </h3>
              <p style={{ fontSize: "11px", color: "var(--text-muted)", margin: "2px 0 0 0" }}>
                Prior Cloud Pass is expired, cancelled, or inactive
              </p>
            </div>
          </div>
          <button className="btn btn-ghost" style={{ padding: "4px 8px" }} onClick={onClose}>
            <X size={16} />
          </button>
        </div>

        {/* Message */}
        <p style={{ fontSize: "12px", color: "#cbd5e1", lineHeight: 1.6, marginBottom: "18px" }}>
          Your saved HackySack Cloud pass is no longer active in our database. To use real-time speech transcription and AI answers, please renew your subscription or switch to 100% Free BYOK mode.
        </p>

        {/* Options */}
        <div style={{ display: "flex", flexDirection: "column", gap: "10px", marginBottom: "16px" }}>
          <button
            className="btn btn-primary"
            style={{
              padding: "10px 14px",
              justifyContent: "space-between",
              fontSize: "12px",
              fontWeight: 700,
              background: "linear-gradient(135deg, #6366f1, #a855f7)",
              boxShadow: "0 4px 15px rgba(99, 102, 241, 0.35)",
            }}
            onClick={() => handleOpenCheckout(WEEKLY_CHECKOUT_URL)}
          >
            <span style={{ display: "flex", alignItems: "center", gap: "6px" }}>
              <RefreshCw size={14} /> Renew 7-Day Sprint Pass ($19.99)
            </span>
            <ExternalLink size={13} style={{ opacity: 0.8 }} />
          </button>

          <button
            className="btn btn-secondary"
            style={{
              padding: "10px 14px",
              justifyContent: "space-between",
              fontSize: "12px",
              fontWeight: 600,
            }}
            onClick={() => handleOpenCheckout(MONTHLY_CHECKOUT_URL)}
          >
            <span style={{ display: "flex", alignItems: "center", gap: "6px" }}>
              <Cloud size={14} /> Renew Pro Monthly Pass ($29.99)
            </span>
            <ExternalLink size={13} style={{ opacity: 0.8 }} />
          </button>

          <button
            className="btn btn-ghost"
            style={{
              padding: "10px 14px",
              justifyContent: "center",
              fontSize: "12px",
              fontWeight: 600,
              border: "1px solid rgba(255, 255, 255, 0.12)",
              color: "#a5b4fc",
              gap: "6px",
            }}
            onClick={onSwitchToBYOK}
          >
            <Key size={14} /> Switch to Free BYOK Mode (Bring Your Own Key)
          </button>
        </div>

        {/* Footer info */}
        <div style={{ textAlign: "center", fontSize: "11px", color: "var(--text-muted)" }}>
          Free BYOK mode supports 100% free Groq, OpenAI, Anthropic, Gemini, & OpenRouter keys.
        </div>
      </div>
    </div>
  );
}
