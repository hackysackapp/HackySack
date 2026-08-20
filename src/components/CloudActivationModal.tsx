import { Sparkles, CheckCircle2, X } from "lucide-react";

interface CloudActivationModalProps {
  onClose: () => void;
}

export function CloudActivationModal({ onClose }: CloudActivationModalProps) {
  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(10, 10, 18, 0.92)",
        backdropFilter: "blur(12px)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 999999,
        padding: "16px",
      }}
    >
      <div
        className="animate-fadeIn"
        style={{
          background: "var(--bg-elevated)",
          border: "1.5px solid rgba(16, 185, 129, 0.5)",
          borderRadius: "18px",
          width: "440px",
          maxWidth: "95vw",
          boxShadow: "0 24px 60px rgba(16, 185, 129, 0.25)",
          overflow: "hidden",
        }}
      >
        {/* Header */}
        <div data-tauri-drag-region style={{ padding: "16px 20px", borderBottom: "1px solid var(--border)", display: "flex", alignItems: "center", justifyContent: "space-between", cursor: "grab" }}>
          <div data-tauri-drag-region style={{ display: "flex", alignItems: "center", gap: "10px" }}>
            <div style={{ width: 32, height: 32, borderRadius: "8px", background: "linear-gradient(135deg, #10b981, #059669)", display: "flex", alignItems: "center", justifyContent: "center", color: "#fff", pointerEvents: "none" }}>
              <Sparkles size={18} />
            </div>
            <div data-tauri-drag-region>
              <h2 data-tauri-drag-region style={{ fontSize: "15px", fontWeight: 700, color: "#ffffff", margin: 0 }}>HackySack Cloud Activated</h2>
              <p data-tauri-drag-region style={{ fontSize: "11px", color: "var(--text-muted)", margin: 0 }}>Subscription Setup Complete</p>
            </div>
          </div>
          <button className="btn btn-ghost" style={{ padding: "4px 8px" }} onClick={onClose}>
            <X size={16} />
          </button>
        </div>

        {/* Body */}
        <div style={{ padding: "24px 20px", textAlign: "center" }}>
          <div style={{ width: 60, height: 60, borderRadius: "50%", background: "rgba(16, 185, 129, 0.15)", border: "2px solid #10b981", display: "flex", alignItems: "center", justifyContent: "center", margin: "0 auto 16px auto", boxShadow: "0 0 25px rgba(16, 185, 129, 0.4)" }}>
            <CheckCircle2 size={32} color="#10b981" />
          </div>

          <span style={{ fontSize: "10px", fontWeight: 800, textTransform: "uppercase", letterSpacing: "1px", color: "#10b981", background: "rgba(16, 185, 129, 0.15)", border: "1px solid rgba(16, 185, 129, 0.35)", padding: "3px 10px", borderRadius: "12px", display: "inline-block", marginBottom: "12px" }}>
            ✨ Activation Successful
          </span>

          <h3 style={{ fontSize: "20px", fontWeight: 800, color: "#ffffff", margin: "0 0 8px 0", lineHeight: 1.3 }}>
            Thank You for Subscribing! 🎉
          </h3>

          <p style={{ fontSize: "12px", color: "var(--text-secondary)", margin: "0 0 20px 0", lineHeight: 1.6 }}>
            Your <strong>HackySack Cloud Pass</strong> is now active. Ultra-fast AI copilot answers, zero API key setup, and premium interview models are unlocked!
          </p>

          <div style={{ background: "rgba(255, 255, 255, 0.03)", border: "1px solid var(--border)", borderRadius: "10px", padding: "10px 14px", marginBottom: "20px", display: "flex", flexDirection: "column", gap: "8px", textAlign: "left", fontSize: "11px" }}>
            <div style={{ display: "flex", justifyContent: "space-between" }}>
              <span style={{ color: "var(--text-muted)" }}>⚡ Standard Credits (Llama 3.3 / DeepSeek V3):</span>
              <span style={{ fontWeight: 700, color: "#10b981" }}>300 / 300 Daily</span>
            </div>
            <div style={{ display: "flex", justifyContent: "space-between" }}>
              <span style={{ color: "var(--text-muted)" }}>👑 Premium Credits (Claude 3.5 / GPT-4o):</span>
              <span style={{ fontWeight: 700, color: "#a855f7" }}>150 / 150 Daily</span>
            </div>
          </div>

          <button
            className="btn btn-primary"
            style={{ width: "100%", padding: "12px", fontSize: "13px", fontWeight: 700, borderRadius: "10px", background: "linear-gradient(135deg, #10b981, #059669)", color: "#ffffff", border: "none", cursor: "pointer", boxShadow: "0 4px 15px rgba(16, 185, 129, 0.35)" }}
            onClick={onClose}
          >
            🚀 Start Using HackySack Cloud
          </button>
        </div>
      </div>
    </div>
  );
}
