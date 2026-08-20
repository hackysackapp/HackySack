import React, { useEffect } from "react";
import { BarChart2, Radio, X, CheckCircle2 } from "lucide-react";

interface OverviewPromptModalProps {
  isOpen: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

export function OverviewPromptModal({ isOpen, onConfirm, onCancel }: OverviewPromptModalProps) {
  useEffect(() => {
    if (!isOpen) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        onCancel();
      } else if (e.key === "Enter") {
        onConfirm();
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [isOpen, onConfirm, onCancel]);

  if (!isOpen) return null;

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 9999,
        background: "rgba(10, 10, 18, 0.88)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: "16px"
      }}
      onClick={onCancel}
    >
      <div
        className="detailModal animate-fadeIn"
        style={{
          width: "100%",
          maxWidth: "420px",
          background: "var(--bg-surface)",
          border: "1px solid var(--border-bright)",
          borderRadius: "var(--radius-lg)",
          padding: "20px",
          boxShadow: "0 20px 50px rgba(0, 0, 0, 0.6)",
          position: "relative"
        }}
        onClick={e => e.stopPropagation()}
      >
        {/* Close button */}
        <button
          className="btn btn-ghost"
          style={{
            position: "absolute",
            top: "14px",
            right: "14px",
            padding: "4px",
            borderRadius: "50%",
            color: "var(--text-muted)"
          }}
          onClick={onCancel}
          title="Close prompt (Stay Here)"
        >
          <X size={16} />
        </button>

        {/* Header with Icon */}
        <div style={{ display: "flex", alignItems: "center", gap: "12px", marginBottom: "14px" }}>
          <div
            style={{
              width: "40px",
              height: "40px",
              borderRadius: "10px",
              background: "linear-gradient(135deg, rgba(99, 102, 241, 0.2), rgba(139, 92, 246, 0.2))",
              border: "1px solid rgba(99, 102, 241, 0.4)",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              color: "var(--accent-start)",
              flexShrink: 0
            }}
          >
            <BarChart2 size={22} />
          </div>
          <div>
            <h3 style={{ margin: 0, fontSize: "15px", fontWeight: 600, color: "var(--text-primary)" }}>
              Recording Stopped
            </h3>
            <span style={{ fontSize: "11px", color: "var(--text-muted)" }}>
              Session captured successfully
            </span>
          </div>
        </div>

        {/* Body content */}
        <p style={{ fontSize: "13px", color: "var(--text-secondary)", lineHeight: 1.5, margin: "0 0 18px 0" }}>
          Would you like to view the <strong>Session Overview</strong> screen to review your transcript and AI summary?
        </p>

        {/* Actions */}
        <div style={{ display: "flex", gap: "10px", justifyContent: "flex-end" }}>
          <button
            className="btn btn-ghost"
            style={{
              fontSize: "12px",
              padding: "8px 14px",
              borderRadius: "var(--radius-md)"
            }}
            onClick={onCancel}
          >
            <Radio size={14} style={{ marginRight: "4px" }} />
            Stay Here
          </button>

          <button
            className="btn btn-primary"
            style={{
              fontSize: "12px",
              padding: "8px 16px",
              fontWeight: 600,
              borderRadius: "var(--radius-md)"
            }}
            onClick={onConfirm}
          >
            <BarChart2 size={14} style={{ marginRight: "4px" }} />
            View Overview
          </button>
        </div>

        {/* Footer info */}
        <div
          style={{
            marginTop: "16px",
            paddingTop: "12px",
            borderTop: "1px solid var(--border)",
            fontSize: "10px",
            color: "var(--text-muted)",
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between"
          }}
        >
          <span>💡 You can disable this prompt anytime in Settings.</span>
        </div>
      </div>
    </div>
  );
}
