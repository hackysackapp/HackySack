import { useState, useRef, useEffect, useCallback } from "react";
import { createPortal } from "react-dom";
import ReactMarkdown from "react-markdown";
import { Copy, Check, Zap, ChevronDown, ChevronRight, Type, Trash2, Brain, AlertTriangle, X } from "lucide-react";
import { listen } from "@tauri-apps/api/event";
import { useTauri, ContextItem, AIResponse as AIResponseType, ModelInfo } from "../hooks/useTauri";
import styles from "./AIResponse.module.css";

// Interview mode definitions (Streamlined to 3 core interview types)
export type InterviewMode = "general" | "behavioral" | "coding";

const MODE_CONFIG: Record<InterviewMode, { label: string; emoji: string; promptHint: string }> = {
  general:    { label: "General / Technical", emoji: "💬", promptHint: "Tailor the response directly to the interviewer's question using relevant experience from the candidate's resume and job description. If the question asks about writing code, SQL queries, data structures, algorithms, or technical implementations in any programming language (SQL, Python, TypeScript, React, Java, C++, Go, Rust, Bash, etc.), ALWAYS include a clear, copy-pasteable working markdown code block snippet illustrating the solution. For non-coding, personal, or purely behavioral questions, never output any code blocks." },
  behavioral: { label: "Behavioral STAR",    emoji: "🎯", promptHint: "Structure strictly using the STAR method (Situation, Task, Action, Result). Highlight specific personal contributions ('I led...', 'I architected...') and finish with concrete, measurable metrics and results. Do not include code blocks." },
  coding:     { label: "Coding & Design",    emoji: "💻", promptHint: "Structure for technical problem-solving, coding challenges & SQL queries: 1. ALWAYS provide an exact, working markdown code snippet or query block for the requested language/dialect (e.g., SQL, Python, TypeScript, Java, C++, Go, Rust, Bash). 2. Brief explanation of algorithm/query logic. 3. Time & Space Complexity." },
};

/** Normalize AI output: convert literal `•` bullets → markdown `- ` list items */
function normalizeMarkdown(text: string): string {
  return text
    // Convert lines starting with a bullet character (•, *, ▪, ◦, –)
    .split("\n")
    .map(line => {
      const m = line.match(/^\s*[•▪◦–\-]\s+(.+)/);
      return m ? `- ${m[1]}` : line;
    })
    .join("\n");
}

/**
 * Efficient multi-turn Q&A context compressor:
 * - Keeps the most recent 1-2 turns in full rich detail (up to 800 chars) for immediate follow-up accuracy.
 * - Distills older turns (3-6) into concise key takeaways (~220 chars) to prevent prompt prefill latency.
 */
function formatPriorQAHistory(historyItems: AIResponseType[]): string {
  const valid = historyItems.filter(h => (h.question || "").trim().length > 0 && (h.content || "").trim().length > 20);
  const recent = valid.slice(0, 6);
  if (recent.length === 0) return "";

  return recent.map((item, idx) => {
    const maxChars = idx < 2 ? 800 : 220;
    const cleanContent = item.content.length > maxChars
      ? item.content.slice(0, maxChars) + "..."
      : item.content;
    const turnLabel = idx === 0 ? "Most Recent Question / Turn" : `Prior Turn ${idx + 1} Question`;
    return `[${turnLabel}]: "${item.question}"\n[Candidate Teleprompter Output]:\n${cleanContent}`;
  }).join("\n\n");
}

function buildInterviewPrompt(
  currentTurn: string,
  responseLength: "brief" | "normal" | "detailed",
  modeHint: string,
  hasPriorContext: boolean = false,
  isOAMode: boolean = false,
  preferredLang: string = "Python 3"
): string {
  if (isOAMode) {
    const isImageSnapshot = currentTurn.includes("Active Screen Snapshot") || currentTurn.includes("Screenshot");
    return `ONLINE CODING ASSESSMENT & TECHNICAL CHALLENGE SOLVER (LeetCode, Codility, HackerRank, CodeSignal):
TARGET PROGRAMMING LANGUAGE: ${preferredLang}

PROBLEM CONTEXT / SCREENSHOT:
"${currentTurn}"

TASK:
You are an expert competitive programmer and principal software engineer solving an active online coding assessment or live coding challenge.
Analyze the problem description, constraints, input/output examples, and starter function signature thoroughly. Provide an optimal, 100% bug-free solution strictly written in ${preferredLang}.

OUTPUT FORMAT (STRICT):
### 1. Optimal Approach & Algorithm
- **Core Technique**: [1-2 sentences on the chosen data structure / pattern, e.g. Monotonic Stack, Two Pointers, DFS/BFS, Dynamic Programming with transition formula].
- **Why Optimal**: [Why this meets the time/space constraints without TLE/MLE].

### 2. Complete Code Solution (${preferredLang})
\`\`\`${preferredLang.toLowerCase().includes("python") ? "python" : preferredLang.toLowerCase().includes("c++") ? "cpp" : preferredLang.toLowerCase().includes("java") ? "java" : preferredLang.toLowerCase().includes("typescript") ? "typescript" : preferredLang.toLowerCase().includes("javascript") ? "javascript" : preferredLang.toLowerCase().includes("rust") ? "rust" : preferredLang.toLowerCase().includes("go") ? "go" : preferredLang.toLowerCase().includes("sql") ? "sql" : preferredLang.toLowerCase().includes("c#") ? "csharp" : ""}
[COMPLETE, copy-pasteable production solution in ${preferredLang}. Include complete function definitions, helper methods, type hints/imports if needed, and thorough handling of edge cases. No ellipsis, placeholders, or missing pieces.]
\`\`\`

### 3. Complexity & Constraints
- **Time Complexity**: $O(\\dots)$ — [Clear derivation based on input size $N$ and constraints].
- **Space Complexity**: $O(\\dots)$ — [Memory/stack overhead].

### 4. Critical Edge Cases & Verification
- **Edge Cases Handled**: [e.g. empty input, single element, negative numbers, extreme scale / integer overflow].
- **Test Case Walkthrough**: [Quick verification tracing Example 1].`;
  }

  const turnHeader = `ACTIVE INTERVIEW TURN / QUESTION:
"${currentTurn}"

TASK: Deliver the best candidate teleprompter response for this immediate turn, fully synthesized with the ongoing conversation history, candidate resume, and target job profile. If this is a follow-up or discussion point, build directly upon earlier discussion points without unnecessary repetition.`;

  let responseStructure = "";

  if (responseLength === "brief") {
    responseStructure = `
FORMAT INSTRUCTION (BRIEF TELEPROMPTER RESPONSE):
- Designed for 0.5-second eye-glancing on a live video call. High speed, high impact.
- Write in first person ("I", "my") as an expert candidate.
- NO conversational preamble ("Certainly", "Great question"). Start IMMEDIATELY with the first header.

SMART CODE RULE (ANY PROGRAMMING / QUERY LANGUAGE):
- If the question involves writing code, SQL queries, algorithms, functions, scripts, or implementations in ANY language (SQL, Python, JS/TS, Java, C++, Go, Rust, Shell, React, etc.), you MUST include a clean, working markdown code block with an illustrative code example snippet.
- Adapt the syntax dynamically to the requested language (or idiomatic standard syntax).
- For non-coding, behavioral, situational, or conceptual questions, NEVER output code blocks.

Structure for Non-Coding Discussion / Behavioral / Conceptual:
### Quick Answer
- **Direct Pitch**: [1-sentence crisp opening hook to speak out loud immediately]
- **Key Talking Points**: [2-3 high-impact keywords, metrics, or core trade-offs to mention]

Structure for Technical / Coding / SQL / System Design:
### Quick Answer
- **Direct Pitch**: [1-sentence overview of query logic, algorithmic approach, or architecture]
- **Key Terms**: [Relevant functions, algorithms, or database keywords]

### Code / Implementation
\`\`\`
[Clean, working code snippet or SQL query in the requested/relevant language]
\`\`\`
`;
  } else if (responseLength === "detailed") {
    responseStructure = `
FORMAT INSTRUCTION (DETAILED TELEPROMPTER RESPONSE):
- In-depth, nuanced candidate response (~220-280 words).
- Write in first person ("I", "my") as an expert candidate.
- NO conversational preamble. Start IMMEDIATELY with the first header.

SMART CODE RULE (ANY PROGRAMMING / QUERY LANGUAGE):
- If the question involves writing code, SQL queries, algorithms, functions, scripts, or implementations in ANY language (SQL, Python, JS/TS, Java, C++, Go, Rust, Shell, React, etc.), you MUST include a clean, working markdown code block with a complete illustrative code example snippet.
- Adapt the syntax dynamically to the requested language (or idiomatic standard syntax).
- For non-coding, behavioral, situational, or conceptual questions, NEVER output code blocks.

Structure for Non-Coding Discussion / Behavioral / System Architecture:
### Strategic Overview
- **Core Pitch**: [1-2 sentence strategic overview to speak immediately]
- **Key Metrics & Technologies**: [High-impact technical terms, metrics, or STAR outcomes]
- **Trade-offs & Nuances**: [Key architectural trade-offs, edge cases, or considerations to discuss]

### Detailed Speaking Response
[Comprehensive, natural 1st-person candidate narrative covering background, technical execution, or full STAR story]

Structure for Technical / Coding / SQL Implementation:
### Strategic Overview
- **Core Pitch**: [1-2 sentence overview of technical architecture or query strategy]
- **Key Concepts**: [Core algorithms, database indexes, or API patterns used]

### Code / Implementation
\`\`\`
[Complete, commented working code snippet or SQL query with edge-case handling in the requested language]
\`\`\`

### Architecture & Complexity Analysis
[Breakdown of design choices, trade-offs, and Time & Space complexity O(N)]
`;
  } else {
    // "normal" (Balanced Teleprompter Response - Fast, natural, high signal)
    responseStructure = `
FORMAT INSTRUCTION (BALANCED TELEPROMPTER RESPONSE):
- Balanced, natural response (~120-150 words total) designed for live video calls.
- Write in first person ("I", "my") as an expert candidate.
- NO conversational preamble. Start IMMEDIATELY with the first header.

SMART CODE RULE (ANY PROGRAMMING / QUERY LANGUAGE):
- If the question involves writing code, SQL queries, algorithms, functions, scripts, or implementations in ANY language (SQL, Python, JS/TS, Java, C++, Go, Rust, Shell, React, etc.), you MUST include a clean, working markdown code block with an illustrative code example snippet.
- Adapt the syntax dynamically to the requested language (or idiomatic standard syntax).
- For non-coding, behavioral, situational, or conceptual questions, NEVER output code blocks.

Structure for Non-Coding Discussion / Follow-Up / Behavioral:
### Quick Pitch
- **Direct Answer**: [1-2 sentence direct, impactful answer to speak out loud immediately]
- **Key Highlights**: [3-4 concise bullet points covering core experience, STAR results, metrics, or key terms]

### Speaking Script
[A natural 30-45 second candidate response written in 1st-person "I" to speak directly to the interviewer, flowing seamlessly from the ongoing discussion]

Structure for Technical / Coding / System Design / SQL:
### Quick Pitch
- **Direct Answer**: [1-2 sentence overview of algorithm, query approach, or technical solution]
- **Key Highlights**: [3-4 concise bullet points covering key functions, performance, or edge cases]

### Code / Implementation
\`\`\`
[Clean, working code snippet or SQL query in the requested/relevant language]
\`\`\`

### Explanation & Complexity
[Concise explanation of algorithm/query logic and Time & Space Complexity (e.g. O(N))]
`;
  }

  return `${turnHeader}\n\n${responseStructure}\n${modeHint}`;
}

interface AIResponseProps {
  contextItems: ContextItem[];
  onBeforeAsk?: () => ContextItem | null;
}

export function AIResponse({ contextItems, onBeforeAsk }: AIResponseProps) {
  const { askAI, askAIStream, getAvailableModels, loading, error } = useTauri();
  const [prompt, setPrompt] = useState("");
  const [showManualPrompt, setShowManualPrompt] = useState(false);
  const [response, setResponse] = useState<AIResponseType | null>(null);
  const [autoResponse, setAutoResponse] = useState<AIResponseType | null>(null);
  const [isStreaming, setIsStreaming] = useState(false);
  const [isAutoStreaming, setIsAutoStreaming] = useState(false);
  const activeRequestTypeRef = useRef<"manual" | "auto" | null>(null);
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [selectedModel, setSelectedModel] = useState<string>(
    localStorage.getItem("hackysack_selected_model") || "anthropic/claude-3.5-sonnet"
  );
  const [responseLength, setResponseLength] = useState<"brief" | "normal" | "detailed">(
    (localStorage.getItem("hackysack_response_length") as any) || "normal"
  );
  const [isPromptExpanded, setIsPromptExpanded] = useState(false);
  const [copied, setCopied] = useState(false);
  const [history, setHistory] = useState<AIResponseType[]>([]);
  const [expandedHistory, setExpandedHistory] = useState<Record<number, boolean>>({});
  const [interviewMode, setInterviewMode] = useState<InterviewMode>(
    (localStorage.getItem("hackysack_interview_mode_type") as InterviewMode) || "general"
  );
  const [requestError, setRequestError] = useState<string | null>(null);
  const responseRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const streamBufferRef = useRef("");
  const [bottomPortal, setBottomPortal] = useState<HTMLElement | null>(null);
  const interviewModeRef = useRef(interviewMode);
  useEffect(() => { interviewModeRef.current = interviewMode; }, [interviewMode]);

  useEffect(() => {
    setBottomPortal(document.getElementById('bottom-dock-portal'));
  }, []);

  const currentQuestionRef = useRef<string>("");
  const answeredQuestionsSetRef = useRef<Set<string>>(new Set());
  const historyRef = useRef<AIResponseType[]>(history);
  useEffect(() => { historyRef.current = history; }, [history]);

  // Stable refs for window-exposed helpers
  const contextItemsRef = useRef(contextItems);
  const onBeforeAskRef  = useRef(onBeforeAsk);
  const isStreamingRef  = useRef(isStreaming);
  const isAutoStreamingRef = useRef(isAutoStreaming);
  const forceCompleteStreamRef = useRef<(() => void) | null>(null);
  const loadingRef      = useRef(loading);
  const responseLengthRef = useRef(responseLength);
  const selectedModelRef  = useRef(selectedModel);
  const askAIRef          = useRef(askAI);
  const askAIStreamRef    = useRef(askAIStream);

  useEffect(() => { contextItemsRef.current = contextItems; },   [contextItems]);
  useEffect(() => { onBeforeAskRef.current  = onBeforeAsk; },    [onBeforeAsk]);
  useEffect(() => { isStreamingRef.current  = isStreaming; },    [isStreaming]);
  useEffect(() => { isAutoStreamingRef.current = isAutoStreaming; }, [isAutoStreaming]);
  useEffect(() => { loadingRef.current      = loading; },        [loading]);
  useEffect(() => { responseLengthRef.current = responseLength; }, [responseLength]);
  useEffect(() => {
    selectedModelRef.current = selectedModel;
    if (selectedModel) {
      localStorage.setItem("hackysack_selected_model", selectedModel);
    }
  }, [selectedModel]);
  useEffect(() => { askAIRef.current          = askAI; },        [askAI]);
  useEffect(() => { askAIStreamRef.current    = askAIStream; },  [askAIStream]);

  // Load available models on mount and resolve primary & secondary default
  useEffect(() => {
    getAvailableModels().then(result => {
      if (result && result.length > 0) {
        setModels(result);
        const saved = localStorage.getItem("hackysack_selected_model");
        if (saved && result.some(m => m.id === saved)) {
          setSelectedModel(saved);
        } else {
          // Cost & Speed-Optimized Default: Gemini 3.7 Flash (Cloud/OpenRouter) or Llama 3.3 70B (Groq)
          const primaryDefault = result.find(m =>
            m.id === "google/gemini-2.5-flash" || m.id === "llama-3.3-70b-versatile"
          );
          if (primaryDefault) {
            setSelectedModel(primaryDefault.id);
          } else {
            // Secondary Fallback Default: Gemini 2.0 Flash or DeepSeek V3
            const secondaryFallback = result.find(m =>
              m.id === "google/gemini-2.0-flash-001" || m.id === "deepseek/deepseek-chat"
            );
            if (secondaryFallback) {
              setSelectedModel(secondaryFallback.id);
            } else {
              setSelectedModel(result[0].id);
            }
          }
        }
      }
    });
  }, []);

  // Auto-scroll response into view
  useEffect(() => {
    if (response) responseRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [response]);

  // Listen for AI stream tokens (mounted once — stable cleanup)
  useEffect(() => {
    let unlistenChunk: (() => void) | null = null;
    let unlistenDone:  (() => void) | null = null;
    let isCancelled = false;
    let renderScheduled = false;
    let chunkTimeout: ReturnType<typeof setTimeout> | null = null;

    const forceCompleteStream = () => {
      if (isCancelled) return;
      const isAuto = activeRequestTypeRef.current === "auto";
      
      isStreamingRef.current = false;
      isAutoStreamingRef.current = false;
      activeRequestTypeRef.current = null;
      (window as any).__isAIWorking = false;

      setIsAutoStreaming(false);
      setIsStreaming(false);

      const finalContent = streamBufferRef.current;
      if (finalContent.trim()) {
        setHasArchivedCurrent(false);
        const resp: AIResponseType = {
          content: finalContent,
          model_used: selectedModelRef.current,
          tokens_used: 0,
          success: true,
          question: currentQuestionRef.current || undefined,
          kind: isAuto ? "auto" : "manual"
        };
        setHistory(h => {
          if (!resp.question) return [resp, ...h].slice(0, 30);
          const normQ = resp.question.trim().toLowerCase();
          const filtered = h.filter(item => !item.question || item.question.trim().toLowerCase() !== normQ);
          return [resp, ...filtered].slice(0, 30);
        });
        if (isAuto) {
          setAutoResponse(resp);
        } else {
          setResponse(resp);
        }
        if (typeof (window as any).__refreshCloudStatus === "function") {
          (window as any).__refreshCloudStatus();
        }
      }
    };
    forceCompleteStreamRef.current = forceCompleteStream;

    listen<string>("ai_stream_chunk", (event) => {
      if (isCancelled || !activeRequestTypeRef.current) return;
      streamBufferRef.current += event.payload;
      
      if (chunkTimeout) clearTimeout(chunkTimeout);
      chunkTimeout = setTimeout(() => {
        console.warn("[AIResponse] Stream idle watchdog (10s). Forcing completion.");
        forceCompleteStream();
      }, 10000);
      
      if (!renderScheduled) {
        renderScheduled = true;
        requestAnimationFrame(() => {
          renderScheduled = false;
          if (isCancelled || !activeRequestTypeRef.current) return;
          const content = streamBufferRef.current;
          const payloadObj = { content, model_used: selectedModelRef.current, tokens_used: 0, success: true };

          if (activeRequestTypeRef.current === "auto") {
            setAutoResponse(payloadObj);
            setIsAutoStreaming(true);
          } else {
            setResponse(payloadObj);
            setIsStreaming(true);
          }
        });
      }
    }).then(unlisten => { if (isCancelled) unlisten(); else unlistenChunk = unlisten; });

    listen<string>("ai_stream_done", () => {
      if (chunkTimeout) clearTimeout(chunkTimeout);
      forceCompleteStream();
    }).then(unlisten => { if (isCancelled) unlisten(); else unlistenDone = unlisten; });

    return () => {
      isCancelled = true;
      if (unlistenChunk) unlistenChunk();
      if (unlistenDone)  unlistenDone();
    };
  }, []);

  // Keep window.__isAIWorking in sync for Auto Question Response mode
  useEffect(() => {
    (window as any).__isAIWorking = loading || isStreaming || isAutoStreaming;
  }, [loading, isStreaming, isAutoStreaming]);

  const handleAsk = useCallback(async (withHistory = false, overridePrompt?: string, isAutoCall = false) => {
    if (loadingRef.current || isStreamingRef.current) return;

    const currentModel    = selectedModelRef.current;
    const currentLength   = responseLengthRef.current;
    const currentItems    = contextItemsRef.current;

    // Build prior session Q&A history context (up to 6 recent exchanges with tiered depth for fast TTFT)
    const formattedQAHistory = formatPriorQAHistory(historyRef.current);
    const hasPriorContext = formattedQAHistory.length > 0;

    // Always inject resume/JD/extra (reads window context + localStorage fallback)
    const ctx = (window as any).__interviewContext || {};
    const resumeVal = ctx.resume?.trim() || localStorage.getItem("hackysack_resume")?.trim() || "";
    const jobDescVal = ctx.jobDesc?.trim() || localStorage.getItem("hackysack_job_desc")?.trim() || "";
    const extraVal = ctx.extra?.trim() || localStorage.getItem("hackysack_extra_context")?.trim() || "";

    const extraItems: ContextItem[] = [];
    if (hasPriorContext) {
      extraItems.push({
        id: `ctx-prior-qa-${Date.now()}`,
        kind: "Document",
        content: `=== PRIOR INTERVIEW QUESTIONS & ANSWERS IN THIS SESSION ===\n${formattedQAHistory}`,
        timestamp: Date.now()
      });
    }

    if (resumeVal)  extraItems.push({ id: `ctx-resume-${Date.now()}`,  kind: "Document", content: `Candidate Resume:\n${resumeVal}`,          timestamp: Date.now() });
    if (jobDescVal) extraItems.push({ id: `ctx-jobdesc-${Date.now()}`, kind: "Document", content: `Target Job Description:\n${jobDescVal}`,  timestamp: Date.now() });
    if (extraVal)   extraItems.push({ id: `ctx-extra-${Date.now()}`,   kind: "Document", content: `Additional Candidate Context:\n${extraVal}`, timestamp: Date.now() });

    // Grab live transcript from ContextBuffer
    const recentContexts: ContextItem[] = [];
    if (onBeforeAskRef.current) {
      const liveBuf = onBeforeAskRef.current();
      if (liveBuf) recentContexts.push(liveBuf);
    }

    let activeContext: ContextItem[] = [...extraItems, ...currentItems, ...recentContexts];

    const currentPrompt = overridePrompt ? overridePrompt.trim() : prompt.trim();

    // Extract target question / conversation turn from prompt or live dialogue context
    let targetQuestion = currentPrompt;
    if (!targetQuestion) {
      const dialogueLines: string[] = [];
      for (let i = 0; i < activeContext.length; i++) {
        if (activeContext[i].kind === "Document") continue;
        const content = activeContext[i].content || "";
        const lines = content.split("\n").map(l => l.trim()).filter(l => l.length > 0);
        for (const l of lines) {
          if (!dialogueLines.includes(l)) {
            dialogueLines.push(l);
          }
        }
      }

      // Identify recent interviewer remarks or dialogue turns
      const interviewerLines = dialogueLines.filter(l => /^them:|^interviewer:|^speaker\s*1:/i.test(l));
      const cleanInterviewerLines = interviewerLines.map(l => l.replace(/^them:\s*|^interviewer:\s*|^speaker\s*1:\s*/i, "").trim());

      const unanswered = cleanInterviewerLines.filter(cleaned => {
        const norm = cleaned.toLowerCase();
        return !answeredQuestionsSetRef.current.has(norm);
      });

      if (unanswered.length > 0) {
        targetQuestion = unanswered.join(" ");
      } else if (cleanInterviewerLines.length > 0) {
        targetQuestion = cleanInterviewerLines[cleanInterviewerLines.length - 1];
      } else if (dialogueLines.length > 0) {
        targetQuestion = dialogueLines[dialogueLines.length - 1].replace(/^you:\s*|^them:\s*|^speaker\s*\d.*:\s*/i, "").trim();
      }
    }

    if (!targetQuestion && !currentPrompt) {
      return;
    }

    const targetQ = targetQuestion || currentPrompt || "";
    currentQuestionRef.current = targetQ || currentQuestionRef.current;

    // Record targetQ into answeredQuestionsSetRef
    if (targetQ) {
      answeredQuestionsSetRef.current.add(targetQ.trim().toLowerCase());
    }

    const modeHint = MODE_CONFIG[interviewModeRef.current]?.promptHint ?? "";
    const finalPrompt = buildInterviewPrompt(targetQ, currentLength, modeHint, hasPriorContext);

    streamBufferRef.current = "";
    activeRequestTypeRef.current = isAutoCall ? "auto" : "manual";
    isStreamingRef.current = true;
    (window as any).__isAIWorking = true;
    setHasArchivedCurrent(false);
    setRequestError(null);
    setIsStreaming(true);
    setResponse({ content: "", model_used: currentModel, tokens_used: 0, success: true });
    setPrompt("");

    // Streaming path
    try {
      const res = await askAIStreamRef.current({ prompt: finalPrompt, contextItems: activeContext, model: currentModel });

      if (res === null && !streamBufferRef.current) {
        // Stream failed with no events — fall back to non-streaming
        isStreamingRef.current = false;
        setIsStreaming(false);
        const result = await askAIRef.current({ prompt: finalPrompt, contextItems: activeContext, model: currentModel });
        if (result && result.content) {
          setResponse(result);
          setHistory(h => [result, ...h].slice(0, 10));
        } else {
          setRequestError("Request could not be completed. If using HackySack Cloud, your subscription token may be inactive or expired. Please check Settings → Cloud Pass.");
        }
      }
    } catch (err: any) {
      console.error("Ask AI error:", err);
      isStreamingRef.current = false;
      (window as any).__isAIWorking = false;
      setIsStreaming(false);
      const msg = err?.message || String(err);
      if (msg.includes("token") || msg.includes("Cloud") || msg.includes("403") || msg.includes("inactive")) {
        setRequestError("HackySack Cloud Token Inactive or Expired. Please check your subscription in Settings.");
        (window as any).__triggerCloudExpiredModal?.();
      } else {
        setRequestError(`Request failed: ${msg}`);
      }
    }
  }, [prompt]);

  const [hasArchivedCurrent, setHasArchivedCurrent] = useState(false);

  // Register window helpers
  useEffect(() => {
    (window as any).__setPromptAndAskAI = (text: string) => {
      setPrompt(text);
      currentQuestionRef.current = text;
      setHasArchivedCurrent(false);
      setTimeout(async () => {
        if (loadingRef.current || isStreamingRef.current) return;
        const currentModel = selectedModelRef.current;
        const ctx = (window as any).__interviewContext || {};
        const resumeVal = ctx.resume?.trim() || localStorage.getItem("hackysack_resume")?.trim() || "";
        const jobDescVal = ctx.jobDesc?.trim() || localStorage.getItem("hackysack_job_desc")?.trim() || "";
        const extraVal = ctx.extra?.trim() || localStorage.getItem("hackysack_extra_context")?.trim() || "";

        const extraItems: ContextItem[] = [];
        const formattedQAHistory = formatPriorQAHistory(historyRef.current);
        const hasPriorContext = formattedQAHistory.length > 0;

        if (hasPriorContext) {
          extraItems.push({
            id: `ctx-prior-qa-${Date.now()}`,
            kind: "Document",
            content: `=== PRIOR INTERVIEW QUESTIONS & ANSWERS IN THIS SESSION ===\n${formattedQAHistory}`,
            timestamp: Date.now()
          });
        }

        if (resumeVal)  extraItems.push({ id: `ctx-rs`, kind: "Document", content: `Candidate Resume:\n${resumeVal}`, timestamp: Date.now() });
        if (jobDescVal) extraItems.push({ id: `ctx-jd`, kind: "Document", content: `Target Job Description:\n${jobDescVal}`, timestamp: Date.now() });
        if (extraVal)   extraItems.push({ id: `ctx-ex`, kind: "Document", content: `Additional Context:\n${extraVal}`, timestamp: Date.now() });

        const modeHint = MODE_CONFIG[interviewModeRef.current]?.promptHint ?? "";
        const finalPrompt = buildInterviewPrompt(text, responseLengthRef.current, modeHint, hasPriorContext);
        streamBufferRef.current = "";
        activeRequestTypeRef.current = "manual";
        isStreamingRef.current = true;
        (window as any).__isAIWorking = true;
        setIsStreaming(true);
        setResponse({ content: "", model_used: currentModel, tokens_used: 0, success: true });
        
        try {
          const res = await askAIStreamRef.current({ prompt: finalPrompt, contextItems: [...extraItems, ...contextItemsRef.current], model: currentModel });
          if (res === null && !streamBufferRef.current) {
            isStreamingRef.current = false;
            setIsStreaming(false);
            const result = await askAIRef.current({ prompt: finalPrompt, contextItems: [...extraItems, ...contextItemsRef.current], model: currentModel });
            if (result) {
              setResponse(result);
              setHistory(h => [result, ...h].slice(0, 10));
            }
          }
        } finally {
          setTimeout(() => {
            if (typeof forceCompleteStreamRef.current === "function") {
              forceCompleteStreamRef.current();
            }
          }, 150);
        }
      }, 50);
    };

    (window as any).__clearAutoResponse = () => setAutoResponse(null);

    (window as any).__archiveActiveResponse = () => {
      if (typeof forceCompleteStreamRef.current === "function") {
        forceCompleteStreamRef.current();
      }
      setAutoResponse(null);
      setResponse(null);
      setHasArchivedCurrent(true);
      setIsAutoStreaming(false);
      setIsStreaming(false);
      (window as any).__isAIWorking = false;
    };

    (window as any).__resetAIResponse = () => {
      streamBufferRef.current = "";
      currentQuestionRef.current = "";
      answeredQuestionsSetRef.current.clear();
      activeRequestTypeRef.current = null;
      setAutoResponse(null);
      setResponse(null);
      setHistory([]);
      setHasArchivedCurrent(false);
      isStreamingRef.current = false;
      isAutoStreamingRef.current = false;
      setIsAutoStreaming(false);
      setIsStreaming(false);
      (window as any).__isAIWorking = false;
    };

    // Auto-response: uses transcript text directly — no extra Whisper flush
    (window as any).__triggerAutoAskAI = (question: string): boolean => {
      if (loadingRef.current || (isStreamingRef.current && activeRequestTypeRef.current === "manual")) {
        return false;
      }

      // Clean up previous buffer without pushing broken fragments to history
      streamBufferRef.current = "";
      isAutoStreamingRef.current = true;
      (window as any).__isAIWorking = true;
      setHasArchivedCurrent(false);
      setIsAutoStreaming(true);

      (async () => {
        currentQuestionRef.current = question;
        const currentModel = selectedModelRef.current;
        const ctx = (window as any).__interviewContext || {};
        const resumeVal = ctx.resume?.trim() || localStorage.getItem("hackysack_resume")?.trim() || "";
        const jobDescVal = ctx.jobDesc?.trim() || localStorage.getItem("hackysack_job_desc")?.trim() || "";
        const extraVal = ctx.extra?.trim() || localStorage.getItem("hackysack_extra_context")?.trim() || "";

        const autoContext: ContextItem[] = [];
        if (resumeVal)  autoContext.push({ id: `ctx-auto-res`, kind: "Document", content: `Candidate Resume:\n${resumeVal}`, timestamp: Date.now() });
        if (jobDescVal) autoContext.push({ id: `ctx-auto-job`, kind: "Document", content: `Target Job Description:\n${jobDescVal}`, timestamp: Date.now() });
        if (extraVal)   autoContext.push({ id: `ctx-auto-ext`, kind: "Document", content: `Additional Context:\n${extraVal}`, timestamp: Date.now() });

        // Include recent Q&A history context with tiered depth for fast TTFT
        const formattedQAHistory = formatPriorQAHistory(historyRef.current);
        const hasPriorContext = formattedQAHistory.length > 0;

        if (hasPriorContext) {
          autoContext.push({
            id: `ctx-prior-qa-${Date.now()}`,
            kind: "Document",
            content: `=== PRIOR INTERVIEW CONVERSATION HISTORY ===\n${formattedQAHistory}`,
            timestamp: Date.now()
          });
        }

        autoContext.push(...contextItemsRef.current);

        const modeHint = MODE_CONFIG[interviewModeRef.current]?.promptHint ?? "";
        const finalPrompt = buildInterviewPrompt(question, responseLengthRef.current, modeHint, hasPriorContext);

        try {
          streamBufferRef.current = "";
          activeRequestTypeRef.current = "auto";
          setAutoResponse({ content: "", model_used: currentModel, tokens_used: 0, success: true });

          const res = await askAIStreamRef.current({ prompt: finalPrompt, contextItems: autoContext, model: currentModel });

          if (res === null && !streamBufferRef.current) {
            const result = await askAIRef.current({ prompt: finalPrompt, contextItems: autoContext, model: currentModel });
            if (result) {
              setAutoResponse(result);
            }
          }
        } catch (err) {
          console.error("Auto ask AI error:", err);
          isAutoStreamingRef.current = false;
          (window as any).__isAIWorking = false;
          setIsAutoStreaming(false);
        }
      })();

      return true;
    };

    (window as any).__askAIWithItems = async (items: ContextItem[]) => {
      if (isStreamingRef.current || isAutoStreamingRef.current) return;
      if (items.length === 0) return;

      const currentModel = selectedModelRef.current;
      const ctx = (window as any).__interviewContext || {};
      const resumeVal = ctx.resume?.trim() || localStorage.getItem("hackysack_resume")?.trim() || "";
      const jobDescVal = ctx.jobDesc?.trim() || localStorage.getItem("hackysack_job_desc")?.trim() || "";
      const extraVal = ctx.extra?.trim() || localStorage.getItem("hackysack_extra_context")?.trim() || "";

      const extraItems: ContextItem[] = [];
      if (resumeVal)  extraItems.push({ id: `ctx-rs-${Date.now()}`, kind: "Document", content: `Candidate Resume:\n${resumeVal}`, timestamp: Date.now() });
      if (jobDescVal) extraItems.push({ id: `ctx-jd-${Date.now()}`, kind: "Document", content: `Target Job Description:\n${jobDescVal}`, timestamp: Date.now() });
      if (extraVal)   extraItems.push({ id: `ctx-ex-${Date.now()}`, kind: "Document", content: `Additional Context:\n${extraVal}`, timestamp: Date.now() });

      // Include prior Q&A exchanges from the current session
      const formattedQAHistory = formatPriorQAHistory(historyRef.current);

      if (formattedQAHistory) {
        extraItems.push({
          id: `ctx-prior-qa-${Date.now()}`,
          kind: "Document",
          content: `=== PRIOR SESSION CONVERSATION HISTORY ===\n${formattedQAHistory}`,
          timestamp: Date.now()
        });
      }

      // Combine prior context items + selected items (deduplicating by ID)
      const allContextMap = new Map<string, ContextItem>();
      [...contextItemsRef.current, ...items].forEach(it => allContextMap.set(it.id, it));
      const mergedContext = Array.from(allContextMap.values());

      const hasImageScreenshot = items.some(i => i.kind === "Screenshot" || i.content.startsWith("data:image/"));
      const targetText = items
        .map(i => (i.content.startsWith("data:image/") ? "Active Screen Snapshot: Please inspect the attached screen capture carefully. Solve the coding problem, analyze the product/website details, answer any questions, or explain the architecture diagram shown directly in this image." : i.content))
        .join("\n\n");
      const isOAMode = localStorage.getItem("hackysack_coding_oa_mode") === "true";
      const preferredLang = localStorage.getItem("hackysack_coding_oa_lang") || "Python 3";
      const modeHint = MODE_CONFIG[interviewModeRef.current]?.promptHint ?? "";
      const finalPrompt = buildInterviewPrompt(targetText, responseLengthRef.current, modeHint, Boolean(formattedQAHistory) && !hasImageScreenshot, isOAMode, preferredLang);

      streamBufferRef.current = "";
      activeRequestTypeRef.current = "manual";
      setIsStreaming(true);
      setResponse({ content: "", model_used: currentModel, tokens_used: 0, success: true });

      const res = await askAIStreamRef.current({ prompt: finalPrompt, contextItems: [...extraItems, ...mergedContext], model: currentModel });
      if (res === null && !streamBufferRef.current) {
        setIsStreaming(false);
        const result = await askAIRef.current({ prompt: finalPrompt, contextItems: [...extraItems, ...mergedContext], model: currentModel });
        if (result) {
          setResponse(result);
          setHistory(h => [result, ...h].slice(0, 30));
        }
      }
    };
  }, [handleAsk]);

  // Global hotkey
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && (e.key === "Enter" || e.code === "Space")) {
        e.preventDefault();
        handleAsk();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [handleAsk]);

  const handleCopy = async () => {
    if (!response) return;
    await navigator.clipboard.writeText(response.content);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleAsk();
    }
  };

  const groupedModels = models.reduce<Record<string, ModelInfo[]>>((acc, m) => {
    (acc[m.provider] ??= []).push(m);
    return acc;
  }, {});

  const toggleExpand = (idx: number) => {
    setExpandedHistory(prev => ({ ...prev, [idx]: !prev[idx] }));
  };

  const currentAnswer = hasArchivedCurrent ? null : history[0];
  const previousAnswers = hasArchivedCurrent ? history : history.slice(1);

  return (
    <div className={styles.wrapper}>
      {/* Main Scrollable Answer Stream Feed */}
      <div className={styles.streamSection}>
        {/* Error Alert Card */}
        {requestError && !isStreaming && !isAutoStreaming && (
          <div className={`${styles.responseCard} animate-fadeIn glass-panel`} style={{ borderColor: 'rgba(239, 68, 68, 0.4)', background: 'rgba(239, 68, 68, 0.08)' }}>
            <div className={styles.responseHeader}>
              <div className={styles.responseMeta}>
                <span className="badge badge-red" style={{ display: 'inline-flex', alignItems: 'center', gap: '4px' }}>
                  <AlertTriangle size={11} /> Request Notice
                </span>
              </div>
              <button
                className="btn btn-ghost"
                style={{ padding: "2px 6px", fontSize: "11px" }}
                onClick={() => setRequestError(null)}
                title="Dismiss"
              >
                ✕
              </button>
            </div>
            <div style={{ color: '#fca5a5', fontSize: '12.5px', marginTop: '6px', lineHeight: '1.5' }}>
              {requestError}
            </div>
          </div>
        )}

        {/* Active streaming card for auto-response */}
        {isAutoStreaming && autoResponse && (
          <div className={`${styles.responseCard} ${styles.autoResponseCard} animate-fadeIn glass-panel`}>
            <div className={styles.responseHeader}>
              <div className={styles.responseMeta}>
                <span className="badge badge-primary">
                  <Zap size={10} /> Auto-Response (Streaming...)
                </span>
                <span style={{ fontSize: "11px", color: "var(--text-muted)", marginLeft: "4px" }}>
                  {autoResponse.model_used}
                </span>
              </div>
            </div>
            <div className={`prose ${styles.responseContent}`}>
              <ReactMarkdown>{normalizeMarkdown(autoResponse.content) + " ▍"}</ReactMarkdown>
            </div>
          </div>
        )}

        {/* Active streaming card for manual response */}
        {isStreaming && response && !isAutoStreaming && (
          <div className={`${styles.responseCard} animate-fadeIn glass-panel`}>
            <div className={styles.responseHeader}>
              <div className={styles.responseMeta}>
                <span className="badge badge-purple">
                  <Zap size={10} /> Generating Response...
                </span>
                <span style={{ fontSize: "11px", color: "var(--text-muted)" }}>
                  {response.model_used}
                </span>
              </div>
            </div>
            <div className={`prose ${styles.responseContent}`}>
              <ReactMarkdown>{normalizeMarkdown(response.content) + " ▍"}</ReactMarkdown>
            </div>
          </div>
        )}

        {/* 1. CURRENT ACTIVE ANSWER (Prominent Top Card) */}
        {!isStreaming && !isAutoStreaming && currentAnswer && (
          <div className={`${styles.responseCard} ${currentAnswer.kind === "auto" ? styles.autoResponseCard : ""} glass-panel`}>
            <div className={styles.responseHeader}>
              <div className={styles.responseMeta}>
                <span className={currentAnswer.kind === "auto" ? "badge badge-primary" : "badge badge-purple"}>
                  <Zap size={10} /> {currentAnswer.kind === "auto" ? "Latest Auto Answer" : "Latest Manual Answer"}
                </span>
                <span style={{ fontSize: "11px", color: "var(--text-muted)", marginLeft: "4px" }}>
                  {currentAnswer.model_used}
                </span>
              </div>
              <button
                className="btn btn-ghost"
                style={{ padding: "3px 8px", fontSize: "11px" }}
                onClick={async () => {
                  await navigator.clipboard.writeText(currentAnswer.content);
                  setCopied(true);
                  setTimeout(() => setCopied(false), 2000);
                }}
              >
                {copied ? <><Check size={11} /> Copied!</> : <><Copy size={11} /> Copy</>}
              </button>
            </div>

            <div className={`prose ${styles.responseContent} selectable`}>
              <ReactMarkdown>{normalizeMarkdown(currentAnswer.content)}</ReactMarkdown>
            </div>
          </div>
        )}

        {/* Empty state */}
        {!isStreaming && !isAutoStreaming && history.length === 0 && (
          <div className={styles.emptyState}>
            <p className={styles.emptyTitle}>HackySack Ready</p>
            <p className={styles.emptySubtitle}>
              Speak or ask questions. Auto-responses and manual queries will appear here in a clean, compact format.
            </p>
          </div>
        )}

        {/* 2. PREVIOUS QUESTIONS (Collapsed Accordion Cards Below Current Answer) */}
        {previousAnswers.length > 0 && (
          <div className={styles.historySection}>
            <p className={styles.historyHeader}>Previous Questions ({previousAnswers.length})</p>
            {previousAnswers.map((item, idx) => {
              const isExpanded = !!expandedHistory[idx];
              const snippet = item.content.replace(/[#*`\n]/g, " ").slice(0, 75).trim();
              const cardTitle = item.question
                ? (item.question.length > 75 ? item.question.slice(0, 75) + "…" : item.question)
                : (snippet ? snippet + "…" : "Previous Answer");

              return (
                <div key={idx} className={styles.historyCard}>
                  <div className={styles.historyCardBar} onClick={() => toggleExpand(idx)}>
                    {isExpanded ? <ChevronDown size={13} style={{ color: "var(--accent-start)" }} /> : <ChevronRight size={13} style={{ color: "var(--text-muted)" }} />}
                    <span className={styles.historyCardTitle}>{cardTitle}</span>
                    <span className="badge badge-purple" style={{ fontSize: "9px", padding: "1px 5px" }}>
                      {item.kind === "auto" ? "Auto" : "Manual"}
                    </span>
                    <button
                      className="btn btn-ghost"
                      style={{ padding: "2px 6px", fontSize: "10px" }}
                      onClick={async (e) => {
                        e.stopPropagation();
                        await navigator.clipboard.writeText(item.content);
                      }}
                      title="Copy previous answer"
                    >
                      <Copy size={10} />
                    </button>
                  </div>

                  {isExpanded && (
                    <div style={{ padding: "8px 10px 10px 10px", borderTop: "1px solid var(--border)" }}>
                      <div className={`prose ${styles.responseContent} selectable`}>
                        <ReactMarkdown>{normalizeMarkdown(item.content)}</ReactMarkdown>
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}

        {/* Sticky Floating Centered Ask AI Button */}
        <div style={{
          position: 'sticky',
          bottom: 0,
          zIndex: 20,
          padding: '10px 0 6px 0',
          background: 'linear-gradient(to top, var(--bg-surface) 85%, transparent)',
          display: 'flex',
          justifyContent: 'center',
          alignItems: 'center',
          marginTop: 'auto'
        }}>
          <button
            id="btn-ask-ai"
            className="btn btn-primary"
            onClick={() => handleAsk()}
            disabled={isStreaming && activeRequestTypeRef.current === "manual"}
            style={{
              padding: '7px 26px',
              fontSize: '12px',
              fontWeight: 600,
              borderRadius: '22px',
              boxShadow: '0 4px 16px rgba(99, 102, 241, 0.5)',
              display: 'inline-flex',
              alignItems: 'center',
              gap: '6px'
            }}
            title="Send active transcript to AI (F12)"
          >
            {isStreaming && activeRequestTypeRef.current === "manual"
              ? <><div className="spinner" style={{ width: 13, height: 13 }} /> Thinking…</>
              : <><Zap size={14} /> Ask AI (F12)</>
            }
          </button>
        </div>
      </div>

      {/* Bottom Command Dock */}
      {bottomPortal ? createPortal(
        <div className={`${styles.askSection} glass-panel`} style={{ border: 'none', borderRadius: 0, padding: 0 }}>
          {showManualPrompt && (
            <div style={{ position: "absolute", bottom: "100%", left: 0, right: 0, padding: "8px 12px", background: "var(--bg-surface)", borderTop: "1px solid var(--border)", zIndex: 10, display: "flex", flexDirection: "column", gap: "6px" }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <span style={{ fontSize: "11px", fontWeight: 600, color: "var(--text-muted)", letterSpacing: "0.04em" }}>Ask Manual Question</span>
                <button
                  className="btn btn-ghost"
                  style={{ padding: "2px 6px", fontSize: "11px", color: "var(--text-muted)" }}
                  onClick={() => setShowManualPrompt(false)}
                  title="Close Manual Question"
                >
                  <X size={13} />
                </button>
              </div>
              <div style={{ display: "flex", gap: "6px", alignItems: "flex-end" }}>
                <textarea
                  ref={textareaRef}
                  id="ai-prompt-input"
                  className={`input ${styles.promptInput}`}
                  placeholder="Type your question… (Enter to send, Shift+Enter for newline)"
                  value={prompt}
                  onChange={e => setPrompt(e.target.value)}
                  onKeyDown={handleKeyDown}
                  rows={2}
                  style={{ minHeight: "44px", padding: "6px 8px", fontSize: "11.5px" }}
                />
                <button
                  className="btn btn-primary"
                  style={{ padding: "8px 14px", height: "44px", borderRadius: "6px", display: "flex", alignItems: "center", gap: "4px", fontSize: "11px", flexShrink: 0 }}
                  onClick={() => handleAsk()}
                  disabled={!prompt.trim() || (isStreaming && activeRequestTypeRef.current === "manual")}
                  title="Send Question (Enter)"
                >
                  <Zap size={13} />
                  <span>Send</span>
                </button>
              </div>
            </div>
          )}

          {/* Compact Controls Row */}
          <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>

            {/* Length dropdown */}
            <div style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
              <span style={{ fontSize: '10.5px', color: 'var(--text-muted)', fontWeight: 600 }}>Length:</span>
              <div className={styles.modelSelect}>
                <select
                  id="length-selector"
                  className={styles.select}
                  value={responseLength}
                  onChange={e => {
                    const l = e.target.value as typeof responseLength;
                    setResponseLength(l);
                    localStorage.setItem('hackysack_response_length', l);
                  }}
                  title="Select AI response detail length"
                >
                  <option value="brief">⚡ Brief</option>
                  <option value="normal">💬 Normal</option>
                  <option value="detailed">📚 Detailed</option>
                </select>
                <ChevronDown size={11} className={styles.selectIcon} />
              </div>
            </div>

            {/* Ask Manual toggle */}
            <button
              className={`btn ${showManualPrompt || prompt ? 'btn-primary' : 'btn-ghost'}`}
              style={{ fontSize: '10px', padding: '3px 9px', gap: '4px' }}
              onClick={() => { setShowManualPrompt(v => !v); setTimeout(() => textareaRef.current?.focus(), 50); }}
              title="Type a custom question"
            >
              <Type size={11} /> {prompt ? 'Edit Q' : 'Manual'}
            </button>

          </div>

          <div className={styles.promptActions}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
              <span style={{ fontSize: '10.5px', color: 'var(--text-muted)', fontWeight: 600 }}>Model:</span>
              <div className={styles.modelSelect}>
                <select
                  id="model-selector"
                  className={styles.select}
                  value={selectedModel}
                  onChange={e => {
                    const newModel = e.target.value;
                    if (isStreamingRef.current || isAutoStreamingRef.current) {
                      if (typeof forceCompleteStreamRef.current === "function") {
                        forceCompleteStreamRef.current();
                      }
                    }
                    streamBufferRef.current = "";
                    setSelectedModel(newModel);
                    selectedModelRef.current = newModel;
                    localStorage.setItem("hackysack_selected_model", newModel);
                  }}
                  title="Select AI model"
                >
                  {Object.entries(groupedModels).map(([provider, provModels]) => (
                    <optgroup key={provider} label={provider}>
                      {provModels.map(m => (
                        <option key={m.id} value={m.id}>{m.name}</option>
                      ))}
                    </optgroup>
                  ))}
                </select>
                <ChevronDown size={12} className={styles.selectIcon} />
              </div>
            </div>
          </div>


          {error && (
            <div className="alert alert-error" style={{ marginTop: 6, padding: 6, borderRadius: 6, backgroundColor: "var(--red-900)", color: "var(--red-100)" }}>
              <strong>Error:</strong> {error}
            </div>
          )}
        </div>,
        bottomPortal
      ) : null}
    </div>
  );
}
