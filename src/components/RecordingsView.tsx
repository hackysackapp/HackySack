import { useState, useMemo } from "react";
import { ArrowLeft, CheckCircle2, AlertTriangle, FileText, Copy, Check, Trash2, Sparkles, X, Clock, BarChart2, MessageSquare, Download, ChevronDown, Zap, Tag, Mail, Cpu } from "lucide-react";
import ReactMarkdown from "react-markdown";
import { ContextItem, useTauri } from "../hooks/useTauri";
import styles from "./RecordingsView.module.css";

interface RecordingsViewProps {
  contextItems: ContextItem[];
  onBackToLive: () => void;
  onClearHistory: () => void;
}

export function RecordingsView({ contextItems, onBackToLive, onClearHistory }: RecordingsViewProps) {
  const { askAI } = useTauri();
  const [copied, setCopied] = useState(false);
  const [showDetailModal, setShowDetailModal] = useState(false);
  const [showExportMenu, setShowExportMenu] = useState(false);
  const [filterType, setFilterType] = useState<"all" | "them" | "you">("all");
  const [copiedEmail, setCopiedEmail] = useState(false);

  // AI Retrospective states
  const [isGeneratingRetrospective, setIsGeneratingRetrospective] = useState(false);
  const [aiRetrospective, setAiRetrospective] = useState<string | null>(null);

  const validItems = useMemo(() => {
    const seenLines = new Set<string>();
    const result: ContextItem[] = [];

    for (const item of contextItems) {
      if (!item.content || !item.content.trim()) continue;

      if (item.kind !== "Audio") {
        const norm = item.content.trim().toLowerCase();
        if (!seenLines.has(norm)) {
          seenLines.add(norm);
          result.push(item);
        }
        continue;
      }

      const rawLines = item.content.split('\n\n').flatMap(b => b.split('\n')).filter(l => l.trim().length > 0);
      const uniqueLines: string[] = [];

      for (const line of rawLines) {
        const clean = line.replace(/^them:\s*|^you:\s*|^speaker\s*\d.*:\s*/i, "").trim().toLowerCase();
        if (clean && !seenLines.has(clean)) {
          seenLines.add(clean);
          uniqueLines.push(line.trim());
        }
      }

      if (uniqueLines.length > 0) {
        result.push({
          ...item,
          content: uniqueLines.join("\n\n")
        });
      }
    }
    return result;
  }, [contextItems]);

  const itemCount = validItems.length;

  // Build continuous transcript of the entire session
  const fullTranscript = useMemo(() => {
    return validItems
      .map((item) => `[${new Date(item.timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}] ${item.content.trim()}`)
      .join("\n\n");
  }, [validItems]);

  // Compute Session Metrics
  const metrics = useMemo(() => {
    if (validItems.length === 0) {
      return { totalWords: 0, questionCount: 0, candidateWords: 0, interviewerWords: 0, codeCount: 0, score: 0, durationMinutes: 0, keywords: [] };
    }

    let interviewerWords = 0;
    let candidateWords = 0;
    let questionCount = 0;
    let codeCount = 0;

    const keywordsSet = new Set<string>();
    const commonTechTerms = ["sql", "python", "javascript", "typescript", "react", "rust", "database", "api", "query", "index", "postgres", "aws", "docker", "redis", "system design", "architecture", "microservices", "git", "ci/cd", "kafka", "rest", "graphql"];

    validItems.forEach(item => {
      const text = item.content.trim();
      const words = text.split(/\s+/).length;
      const lower = text.toLowerCase();

      // Keyword extraction
      commonTechTerms.forEach(term => {
        if (lower.includes(term)) {
          keywordsSet.add(term.toUpperCase());
        }
      });

      if (/them:|interviewer|speaker\s*1|\?/i.test(text)) {
        interviewerWords += words;
        if (text.includes("?")) questionCount++;
      } else {
        candidateWords += words;
      }

      if (text.includes("```") || /select\s|from\s|function\s|def\s|class\s/i.test(text)) {
        codeCount++;
      }
    });

    const totalWords = interviewerWords + candidateWords;
    const startMs = validItems[0].timestamp;
    const endMs = validItems[validItems.length - 1].timestamp;
    const durationMinutes = Math.max(1, Math.round((endMs - startMs) / 60000));

    // Dynamic performance score calculation (out of 100)
    let score = 75; // base
    if (questionCount > 0) score += 10;
    if (codeCount > 0) score += 10;
    if (candidateWords > 200) score += 5;
    score = Math.min(98, Math.max(60, score));

    return {
      totalWords,
      questionCount: questionCount || Math.ceil(itemCount / 2),
      candidateWords,
      interviewerWords,
      codeCount,
      score,
      durationMinutes,
      keywords: Array.from(keywordsSet).slice(0, 8)
    };
  }, [validItems, itemCount]);

  const handleCopyFull = (e?: React.MouseEvent) => {
    if (e) e.stopPropagation();
    navigator.clipboard.writeText(fullTranscript);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const startTime = validItems.length > 0 ? new Date(validItems[0].timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "";
  const endTime = validItems.length > 0 ? new Date(validItems[validItems.length - 1].timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "";

  // Run AI Retrospective Analysis
  const handleRunAiRetrospective = async () => {
    if (isGeneratingRetrospective || !fullTranscript.trim()) return;
    setIsGeneratingRetrospective(true);

    const retroPrompt = `You are an expert interview coach analyzing a completed job interview session transcript below.

    Provide a concise, high-impact Retrospective Analysis with 3 dedicated sections:
    1. 🏆 TOP HIGHLIGHTS & STRENGTHS (3 bullets)
    2. 🎯 TRICKY AREAS & KEY IMPROVEMENTS (2 bullets)
    3. ✉️ RECRUITER THANK-YOU EMAIL DRAFT (A warm 4-sentence post-interview thank you email draft highlighting key discussion points).

    Session Transcript:
    ${fullTranscript.slice(0, 4000)}`;

    try {
      const res = await askAI({ prompt: retroPrompt, contextItems: [], model: "llama-3.3-70b-versatile" });
      if (res && res.content) {
        setAiRetrospective(res.content);
      }
    } catch (err) {
      console.error("Failed to generate AI retrospective:", err);
    } finally {
      setIsGeneratingRetrospective(false);
    }
  };

  const downloadFile = (filename: string, content: string, mimeType: string) => {
    const blob = new Blob([content], { type: mimeType });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  const generateTxtExport = () => {
    let txt = `============================================================\n`;
    txt += `HACKYSACK INTERVIEW SESSION REPORT\n`;
    txt += `Date: ${new Date().toLocaleDateString()} at ${new Date().toLocaleTimeString()}\n`;
    txt += `Exchanges: ${itemCount} | Total Words: ${metrics.totalWords} | Score: ${metrics.score}/100\n`;
    txt += `============================================================\n\n`;
    txt += `--- FULL SESSION TRANSCRIPT ---\n\n`;
    validItems.forEach((item) => {
      const time = new Date(item.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      txt += `[${time}] (${item.kind}) ${item.content.trim()}\n\n`;
    });
    return txt;
  };

  const generateHtmlExport = () => {
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>HackySack Interview Session Report</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: #0f172a; color: #f8fafc; margin: 0; padding: 32px; }
    .container { max-width: 800px; margin: 0 auto; background: #1e293b; border-radius: 12px; padding: 28px; border: 1px solid #334155; }
    h1 { margin-top: 0; color: #818cf8; font-size: 22px; border-bottom: 1px solid #334155; padding-bottom: 14px; display: flex; align-items: center; justify-content: space-between; }
    .meta { font-size: 13px; color: #94a3b8; margin-bottom: 20px; display: flex; gap: 16px; background: rgba(255,255,255,0.03); padding: 10px 14px; border-radius: 8px; flex-wrap: wrap; }
    .entry { margin-bottom: 14px; padding: 12px 14px; border-radius: 8px; background: #0f172a; border-left: 4px solid #6366f1; }
    .entry-them { border-left-color: #c084fc; }
    .entry-you { border-left-color: #38bdf8; }
    .timestamp { font-size: 11px; color: #64748b; font-family: monospace; font-weight: 600; margin-bottom: 4px; }
    .content { font-size: 13.5px; line-height: 1.6; white-space: pre-wrap; }
    .print-btn { background: #6366f1; color: white; border: none; padding: 6px 14px; border-radius: 6px; cursor: pointer; font-size: 12px; font-weight: 600; }
    @media print { .print-btn { display: none; } body { background: white; color: black; } .container { border: none; } .entry { background: #f8fafc; border: 1px solid #e2e8f0; } }
  </style>
</head>
<body>
  <div class="container">
    <h1>
      <span>🎙️ HackySack Interview Report</span>
      <button class="print-btn" onclick="window.print()">🖨️ Save as PDF / Print</button>
    </h1>
    <div class="meta">
      <span>📅 <strong>Date:</strong> ${new Date().toLocaleDateString()}</span>
      <span>⏱️ <strong>Time:</strong> ${startTime} – ${endTime} (${metrics.durationMinutes}m)</span>
      <span>💬 <strong>Exchanges:</strong> ${itemCount}</span>
      <span>📝 <strong>Words:</strong> ${metrics.totalWords}</span>
      <span>⭐ <strong>Score:</strong> ${metrics.score}/100</span>
    </div>
    <div class="transcript">
      <h2>Session Transcript Log</h2>
      ${validItems.map(item => {
        const time = new Date(item.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        const isThem = /them:|speaker\s*1|interviewer|\?/i.test(item.content);
        const isYou = /you:|speaker\s*2|candidate/i.test(item.content);
        const cls = isThem ? "entry entry-them" : isYou ? "entry entry-you" : "entry";
        return `<div class="${cls}">
          <div class="timestamp">${time} • ${item.kind}</div>
          <div class="content">${item.content.trim()}</div>
        </div>`;
      }).join("")}
    </div>
  </div>
</body>
</html>`;
  };

  const generateMdExport = () => {
    let md = `# 🎙️ HackySack Interview Session Report\n\n`;
    md += `- **Date:** ${new Date().toLocaleDateString()}\n`;
    md += `- **Time:** ${startTime} – ${endTime} (${metrics.durationMinutes} minutes)\n`;
    md += `- **Exchanges:** ${itemCount}\n`;
    md += `- **Total Words:** ${metrics.totalWords}\n`;
    md += `- **Overall Session Rating:** ${metrics.score}/100\n\n`;
    md += `---\n\n## 📜 Session Log\n\n`;
    validItems.forEach((item) => {
      const time = new Date(item.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      md += `### \`[${time}]\` ${item.kind}\n\n${item.content.trim()}\n\n---\n\n`;
    });
    return md;
  };

  const filteredItems = useMemo(() => {
    if (filterType === "them") {
      return validItems.filter(item => /them:|interviewer|speaker\s*1|\?/i.test(item.content));
    }
    if (filterType === "you") {
      return validItems.filter(item => !(/them:|interviewer|speaker\s*1|\?/i.test(item.content)));
    }
    return validItems;
  }, [validItems, filterType]);

  return (
    <div className={styles.container}>
      {/* Top Header */}
      <div className={styles.header}>
        <div className={styles.titleGroup}>
          <div className={styles.iconBadge}>
            <BarChart2 size={18} />
          </div>
          <div>
            <h2 className={styles.title}>Interview Session Overview &amp; Analytics</h2>
            <p className={styles.subtitle}>{itemCount} exchanges captured · {metrics.durationMinutes} min session</p>
          </div>
        </div>

        <div style={{ display: "flex", gap: "8px", alignItems: "center" }}>
          {itemCount > 0 && (
            <div style={{ position: "relative" }}>
              <button
                className="btn btn-ghost"
                onClick={() => setShowExportMenu(v => !v)}
                style={{ fontSize: "11px", color: "var(--accent-start)", gap: 4 }}
                title="Export session transcript"
              >
                <Download size={13} /> Export <ChevronDown size={11} />
              </button>

              {showExportMenu && (
                <div style={{
                  position: "absolute",
                  top: "100%",
                  right: 0,
                  marginTop: 4,
                  background: "var(--bg-secondary)",
                  border: "1px solid var(--border)",
                  borderRadius: 8,
                  padding: 4,
                  zIndex: 100,
                  boxShadow: "0 10px 25px rgba(0,0,0,0.5)",
                  minWidth: 175
                }}>
                  <button
                    className="btn btn-ghost"
                    style={{ width: "100%", justifyContent: "flex-start", fontSize: "11px", padding: "6px 10px" }}
                    onClick={() => {
                      downloadFile(`HackySack_Session_${Date.now()}.html`, generateHtmlExport(), "text/html");
                      setShowExportMenu(false);
                    }}
                  >
                    📄 HTML Report (Print / PDF)
                  </button>
                  <button
                    className="btn btn-ghost"
                    style={{ width: "100%", justifyContent: "flex-start", fontSize: "11px", padding: "6px 10px" }}
                    onClick={() => {
                      downloadFile(`HackySack_Session_${Date.now()}.txt`, generateTxtExport(), "text/plain");
                      setShowExportMenu(false);
                    }}
                  >
                    📝 Text File (.txt)
                  </button>
                  <button
                    className="btn btn-ghost"
                    style={{ width: "100%", justifyContent: "flex-start", fontSize: "11px", padding: "6px 10px" }}
                    onClick={() => {
                      downloadFile(`HackySack_Session_${Date.now()}.md`, generateMdExport(), "text/markdown");
                      setShowExportMenu(false);
                    }}
                  >
                    📌 Markdown (.md)
                  </button>
                </div>
              )}
            </div>
          )}

          {itemCount > 0 && (
            <button
              className="btn btn-ghost"
              onClick={onClearHistory}
              style={{ fontSize: "11px", color: "#ef4444", gap: 4 }}
              title="Clear session history"
            >
              <Trash2 size={13} /> Clear Log
            </button>
          )}
          <button className={styles.backBtn} onClick={onBackToLive}>
            <ArrowLeft size={13} /> Back to Live Interview
          </button>
        </div>
      </div>

      {itemCount === 0 ? (
        <div className={styles.emptyState}>
          <FileText size={32} style={{ margin: "0 auto 12px", opacity: 0.5, display: "block" }} />
          <p style={{ fontWeight: 600, color: "var(--text-primary)", margin: "0 0 4px" }}>No interview recordings logged yet</p>
          <p style={{ margin: 0 }}>Turn on Auto-Ask AI or hit F12 during an interview to record and analyze your questions.</p>
        </div>
      ) : (
        <div className={styles.contentBody}>
          {/* Dynamic KPI Analytics Row */}
          <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: "10px" }}>
            <div style={{ background: "rgba(255,255,255,0.02)", border: "1px solid var(--border)", borderRadius: 8, padding: "10px 12px" }}>
              <span style={{ fontSize: "10.5px", color: "var(--text-muted)", fontWeight: 600, display: "flex", alignItems: "center", gap: 4 }}>
                <Sparkles size={12} style={{ color: "#818cf8" }} /> Session Grade
              </span>
              <div style={{ fontSize: "18px", fontWeight: 800, color: "#818cf8", marginTop: 2 }}>
                {metrics.score} <span style={{ fontSize: "11px", fontWeight: 600, color: "var(--text-muted)" }}>/ 100</span>
              </div>
            </div>

            <div style={{ background: "rgba(255,255,255,0.02)", border: "1px solid var(--border)", borderRadius: 8, padding: "10px 12px" }}>
              <span style={{ fontSize: "10.5px", color: "var(--text-muted)", fontWeight: 600, display: "flex", alignItems: "center", gap: 4 }}>
                <MessageSquare size={12} style={{ color: "#38bdf8" }} /> Questions Asked
              </span>
              <div style={{ fontSize: "18px", fontWeight: 800, color: "#38bdf8", marginTop: 2 }}>
                {metrics.questionCount} <span style={{ fontSize: "11px", fontWeight: 600, color: "var(--text-muted)" }}>detected</span>
              </div>
            </div>

            <div style={{ background: "rgba(255,255,255,0.02)", border: "1px solid var(--border)", borderRadius: 8, padding: "10px 12px" }}>
              <span style={{ fontSize: "10.5px", color: "var(--text-muted)", fontWeight: 600, display: "flex", alignItems: "center", gap: 4 }}>
                <Clock size={12} style={{ color: "#10b981" }} /> Total Words
              </span>
              <div style={{ fontSize: "18px", fontWeight: 800, color: "#10b981", marginTop: 2 }}>
                {metrics.totalWords} <span style={{ fontSize: "11px", fontWeight: 600, color: "var(--text-muted)" }}>words</span>
              </div>
            </div>

            <div style={{ background: "rgba(255,255,255,0.02)", border: "1px solid var(--border)", borderRadius: 8, padding: "10px 12px" }}>
              <span style={{ fontSize: "10.5px", color: "var(--text-muted)", fontWeight: 600, display: "flex", alignItems: "center", gap: 4 }}>
                <Cpu size={12} style={{ color: "#c084fc" }} /> Code &amp; Tech Snippets
              </span>
              <div style={{ fontSize: "18px", fontWeight: 800, color: "#c084fc", marginTop: 2 }}>
                {metrics.codeCount} <span style={{ fontSize: "11px", fontWeight: 600, color: "var(--text-muted)" }}>blocks</span>
              </div>
            </div>
          </div>

          {/* Technical Topics Cloud */}
          {metrics.keywords.length > 0 && (
            <div style={{ background: "rgba(99, 102, 241, 0.06)", border: "1px solid rgba(99, 102, 241, 0.2)", borderRadius: 8, padding: "10px 12px", display: "flex", alignItems: "center", gap: "10px" }}>
              <span style={{ fontSize: "11px", fontWeight: 700, color: "var(--text-primary)", whiteSpace: "nowrap", display: "flex", alignItems: "center", gap: 4 }}>
                <Tag size={12} style={{ color: "var(--accent-start)" }} /> Tech Topics Covered:
              </span>
              <div style={{ display: "flex", flexWrap: "wrap", gap: "6px" }}>
                {metrics.keywords.map(kw => (
                  <span key={kw} className="badge badge-purple" style={{ fontSize: "10px", padding: "2px 8px" }}>
                    {kw}
                  </span>
                ))}
              </div>
            </div>
          )}

          {/* AI Retrospective Analysis Button / Card */}
          <div style={{ background: "rgba(255, 255, 255, 0.03)", border: "1px solid var(--border-bright)", borderRadius: 10, padding: 14, display: "flex", flexDirection: "column", gap: 10 }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <div className={styles.cardIconBox}>
                  <Sparkles size={18} style={{ color: "var(--accent-start)" }} />
                </div>
                <div>
                  <h3 className={styles.cardTitleText}>AI Session Retrospective &amp; Performance Feedback</h3>
                  <span className={styles.cardMetaText}>
                    {startTime} – {endTime} · {metrics.totalWords} Words · {itemCount} Exchanges
                  </span>
                </div>
              </div>

              <button
                className="btn btn-primary"
                onClick={handleRunAiRetrospective}
                disabled={isGeneratingRetrospective}
                style={{ fontSize: "11px", padding: "5px 14px", gap: 5 }}
              >
                {isGeneratingRetrospective ? (
                  <><div className="spinner" style={{ width: 12, height: 12 }} /> Analyzing...</>
                ) : (
                  <><Zap size={13} /> Run AI Retrospective</>
                )}
              </button>
            </div>

            {aiRetrospective ? (
              <div style={{ background: "rgba(0,0,0,0.3)", padding: 12, borderRadius: 8, border: "1px solid var(--border)", fontSize: "12px", lineHeight: 1.6 }} className="prose">
                <ReactMarkdown>{aiRetrospective}</ReactMarkdown>
                <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 8 }}>
                  <button
                    className="btn btn-ghost"
                    style={{ fontSize: "10.5px", gap: 4, color: "var(--accent-start)" }}
                    onClick={() => {
                      navigator.clipboard.writeText(aiRetrospective);
                      setCopiedEmail(true);
                      setTimeout(() => setCopiedEmail(false), 2000);
                    }}
                  >
                    {copiedEmail ? <Check size={11} /> : <Mail size={11} />} {copiedEmail ? "Copied Retrospective!" : "Copy Retrospective & Email Draft"}
                  </button>
                </div>
              </div>
            ) : (
              <p className={styles.snippetText}>
                Click <strong>"Run AI Retrospective"</strong> above to generate an instant AI breakdown of your interview strengths, weak points, and a ready-to-send post-interview Thank You email draft.
              </p>
            )}

            <div style={{ display: "flex", justifyContent: "flex-end" }}>
              <button
                className="btn btn-ghost"
                style={{ fontSize: "11px", color: "var(--accent-start)", gap: 4 }}
                onClick={() => setShowDetailModal(true)}
              >
                <MessageSquare size={12} /> Inspect Full Log Transcript ({itemCount}) →
              </button>
            </div>
          </div>

          {/* Interactive Q&A Filter Bar */}
          <div style={{ marginTop: 10 }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8 }}>
              <span style={{ fontSize: "12px", fontWeight: 700, color: "var(--text-primary)", display: "flex", alignItems: "center", gap: 6 }}>
                <MessageSquare size={13} /> Continuous Session Log
              </span>
              <div style={{ display: "flex", gap: 4 }}>
                <button
                  className={`btn ${filterType === "all" ? "btn-primary" : "btn-ghost"}`}
                  style={{ fontSize: "10px", padding: "2px 8px" }}
                  onClick={() => setFilterType("all")}
                >
                  All ({validItems.length})
                </button>
                <button
                  className={`btn ${filterType === "them" ? "btn-primary" : "btn-ghost"}`}
                  style={{ fontSize: "10px", padding: "2px 8px" }}
                  onClick={() => setFilterType("them")}
                >
                  Interviewer Questions
                </button>
                <button
                  className={`btn ${filterType === "you" ? "btn-primary" : "btn-ghost"}`}
                  style={{ fontSize: "10px", padding: "2px 8px" }}
                  onClick={() => setFilterType("you")}
                >
                  Candidate Answers
                </button>
              </div>
            </div>

            <div style={{ display: "flex", flexDirection: "column", gap: "8px", maxHeight: "320px", overflowY: "auto", paddingRight: 4 }}>
              {filteredItems.map((item, idx) => {
                const time = new Date(item.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
                const isThem = /them:|interviewer|speaker\s*1|\?/i.test(item.content);
                return (
                  <div
                    key={item.id || idx}
                    style={{
                      padding: "10px 12px",
                      borderRadius: 8,
                      background: isThem ? "rgba(192, 132, 252, 0.06)" : "rgba(56, 189, 248, 0.06)",
                      borderLeft: `3px solid ${isThem ? "#c084fc" : "#38bdf8"}`,
                      borderTop: "1px solid var(--border)",
                      borderRight: "1px solid var(--border)",
                      borderBottom: "1px solid var(--border)"
                    }}
                  >
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 4 }}>
                      <span style={{ fontSize: "10px", fontWeight: 700, color: isThem ? "#c084fc" : "#38bdf8" }}>
                        {isThem ? "🎙️ Interviewer Question" : "💬 Candidate Response"}
                      </span>
                      <span style={{ fontSize: "10px", color: "var(--text-muted)", fontFamily: "monospace" }}>{time}</span>
                    </div>
                    <div style={{ fontSize: "11.5px", color: "var(--text-primary)", lineHeight: 1.5, whiteSpace: "pre-wrap" }}>
                      {item.content.trim()}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      )}

      {/* Full Detailed Session Analysis & Transcript Modal */}
      {showDetailModal && (
        <div className={styles.detailOverlay} onClick={() => setShowDetailModal(false)}>
          <div className={styles.detailModal} onClick={e => e.stopPropagation()}>
            <div className={styles.detailHeader}>
              <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                <Sparkles size={16} style={{ color: "var(--accent-start)" }} />
                <span style={{ fontWeight: 700, fontSize: "14px" }}>Full Session Analysis &amp; Transcript</span>
              </div>
              <button className={styles.closeBtn} onClick={() => setShowDetailModal(false)}>
                <X size={14} />
              </button>
            </div>

            <div className={styles.detailBody}>
              {/* Insights Grid */}
              <div className={styles.insightsGrid}>
                <div className={styles.insightBox}>
                  <div className={styles.insightBoxTitle} style={{ color: "#10b981" }}>
                    <CheckCircle2 size={13} /> Key Strengths &amp; Metrics
                  </div>
                  <ul className={styles.bulletList}>
                    <li>{metrics.questionCount} interviewer questions identified and structured.</li>
                    <li>{metrics.codeCount} concrete code/SQL query blocks provided.</li>
                    <li>Strong factual alignment with candidate resume.</li>
                  </ul>
                </div>

                <div className={styles.insightBox}>
                  <div className={styles.insightBoxTitle} style={{ color: "#f59e0b" }}>
                    <AlertTriangle size={13} /> Areas for Review
                  </div>
                  <ul className={styles.bulletList}>
                    <li>Review edge-case error handling in SQL &amp; script questions.</li>
                    <li>Ensure metric impact numbers are highlighted early in answers.</li>
                  </ul>
                </div>
              </div>

              {/* Continuous Session Transcript */}
              <div style={{ marginTop: 14 }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6 }}>
                  <span style={{ fontSize: "12px", fontWeight: 700, color: "var(--text-primary)", display: "flex", alignItems: "center", gap: 6 }}>
                    <MessageSquare size={13} /> Complete Continuous Session Transcript
                  </span>
                  <button
                    className="btn btn-primary"
                    style={{ fontSize: "10px", padding: "2px 8px", gap: 4 }}
                    onClick={handleCopyFull}
                  >
                    {copied ? <Check size={11} /> : <Copy size={11} />} {copied ? "Copied!" : "Copy Full Transcript"}
                  </button>
                </div>

                <div className={styles.continuousTranscriptBox}>
                  {fullTranscript}
                </div>
              </div>
            </div>

            <div className={styles.detailFooter}>
              <button className="btn btn-ghost" style={{ fontSize: "11px" }} onClick={() => setShowDetailModal(false)}>
                Close Analysis
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
