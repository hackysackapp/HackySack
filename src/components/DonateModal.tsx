import { useState } from "react";
import { Coffee, Heart, ExternalLink, X, Copy, Check, Sparkles } from "lucide-react";
import { open as shellOpen } from "@tauri-apps/plugin-shell";

interface DonateModalProps {
  onClose: () => void;
}

export function DonateModal({ onClose }: DonateModalProps) {
  const [copied, setCopied] = useState(false);
  const KOFI_URL = "https://ko-fi.com/hackysackapp";

  const handleOpenBrowser = () => {
    try {
      shellOpen(KOFI_URL);
    } catch {
      window.open(KOFI_URL, "_blank");
    }
  };

  const handleCopyLink = () => {
    navigator.clipboard.writeText(KOFI_URL);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
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
        background: "rgba(10, 10, 18, 0.88)",
        backdropFilter: "blur(8px)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 999999,
        padding: "20px",
      }}
    >
      <div
        className="animate-fadeIn"
        onClick={e => e.stopPropagation()}
        style={{
          background: "var(--bg-elevated, #161826)",
          border: "1px solid rgba(245, 158, 11, 0.35)",
          borderRadius: "var(--radius-xl, 16px)",
          width: "460px",
          maxWidth: "95vw",
          boxShadow: "0 24px 60px rgba(0, 0, 0, 0.8)",
          overflow: "hidden",
        }}
      >
        {/* Modal Header */}
        <div
          data-tauri-drag-region
          style={{
            padding: "18px 22px",
            borderBottom: "1px solid var(--border)",
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            background: "linear-gradient(135deg, rgba(245, 158, 11, 0.12), rgba(217, 119, 6, 0.05))",
          }}
        >
          <div data-tauri-drag-region style={{ display: "flex", alignItems: "center", gap: "10px" }}>
            <div
              style={{
                width: 36,
                height: 36,
                borderRadius: "10px",
                background: "linear-gradient(135deg, #f59e0b, #d97706)",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                color: "#fff",
                boxShadow: "0 4px 12px rgba(245, 158, 11, 0.3)",
              }}
            >
              <Coffee size={20} />
            </div>
            <div data-tauri-drag-region>
              <h3 data-tauri-drag-region style={{ fontSize: "15px", fontWeight: 700, color: "var(--text-primary)", margin: 0 }}>
                Buy me a coffee or loaf of bread ☕🍞
              </h3>
              <p data-tauri-drag-region style={{ fontSize: "11px", color: "var(--text-muted)", margin: 0 }}>
                Support HackySack Open-Source Development
              </p>
            </div>
          </div>
          <button className="btn btn-ghost" style={{ padding: "4px 8px" }} onClick={onClose}>
            <X size={16} />
          </button>
        </div>

        {/* Modal Body */}
        <div style={{ padding: "20px 22px 24px" }}>
          <div
            style={{
              background: "rgba(255, 255, 255, 0.03)",
              border: "1px solid var(--border)",
              borderRadius: "var(--radius-md, 10px)",
              padding: "14px 16px",
              marginBottom: "18px",
              fontSize: "12px",
              lineHeight: 1.55,
              color: "var(--text-secondary)",
            }}
          >
            <p style={{ margin: "0 0 10px 0" }}>
              <strong>HackySack</strong> is 100% open-source software built to help job seekers ace live technical interviews, transcribe system audio, and get real-time AI assistance effortlessly.
            </p>
            <p style={{ margin: 0, color: "#f59e0b", fontWeight: 600 }}>
              If HackySack saved you time or helped you land a job, your support means the world! ❤️
            </p>
          </div>

          <div style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
            <button
              className="btn"
              onClick={handleOpenBrowser}
              style={{
                width: "100%",
                justifyContent: "center",
                padding: "12px",
                fontSize: "13px",
                fontWeight: 700,
                gap: "8px",
                background: "linear-gradient(135deg, #f59e0b, #d97706)",
                color: "#000",
                borderRadius: "var(--radius-md, 10px)",
                boxShadow: "0 4px 14px rgba(245, 158, 11, 0.35)",
                border: "none",
                cursor: "pointer",
                transition: "transform 150ms ease, box-shadow 150ms ease",
              }}
            >
              <Heart size={16} fill="#000" /> Donate on Ko-fi <ExternalLink size={14} />
            </button>

            <div style={{ display: "flex", gap: "8px", marginTop: "4px" }}>
              <input
                type="text"
                readOnly
                value={KOFI_URL}
                className="input"
                style={{ flex: 1, fontSize: "11px", color: "var(--text-muted)", background: "rgba(0,0,0,0.2)" }}
              />
              <button
                className="btn btn-secondary"
                onClick={handleCopyLink}
                style={{ fontSize: "11px", padding: "6px 12px", gap: "4px" }}
              >
                {copied ? <Check size={12} color="#10b981" /> : <Copy size={12} />}
                {copied ? "Copied!" : "Copy Link"}
              </button>
            </div>
          </div>

          <div style={{ marginTop: "14px", textAlign: "center", fontSize: "10.5px", color: "var(--text-muted)" }}>
            🔒 Safe &amp; Secure via Ko-fi • No subscription required
          </div>
        </div>
      </div>
    </div>
  );
}
