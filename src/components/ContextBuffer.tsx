import { useState, useEffect, useRef, useCallback } from "react";
import { createPortal } from "react-dom";
import { Mic, MicOff, Camera, Type, Trash2, Clock, UserCheck, Sparkles, CheckSquare, Square } from "lucide-react";
import { useTauri, ContextItem } from "../hooks/useTauri";
import { listen, UnlistenFn } from "@tauri-apps/api/event";
import { Waveform } from "./Waveform";
import styles from "./ContextBuffer.module.css";

interface ContextBufferProps {
  items: ContextItem[];
  onItemsChange: (items: ContextItem[]) => void;
  registerFlushCallback?: (cb: () => ContextItem | null) => void;
  onRecordingStart?: () => void;
  onRecordingStop?: () => void;
}

// Kind Icons
const kindIcon: Record<ContextItem["kind"], React.ReactNode> = {
  Audio:      <Mic size={13} />,
  Screenshot: <Camera size={13} />,
  Text:       <Type size={13} />,
  Document:   <Type size={13} />,
};

const kindColor: Record<ContextItem["kind"], string> = {
  Audio:      "badge-red",
  Screenshot: "badge-blue",
  Text:       "badge-purple",
  Document:   "badge-yellow",
};

export function isInterviewQuestion(line: string): boolean {
  // Strip speaker labels and conversational fillers (so, okay, alright, well, etc.)
  let clean = line.replace(/^them:\s*|^you:\s*|^speaker\s*\d.*:\s*/i, "").trim().toLowerCase();
  clean = clean.replace(/^(so|okay|ok|alright|well|now|great|hi|hello|yeah|cool|sure)\s*,?\s*/i, "").trim();
  if (!clean || clean.length < 5) return false;

  if (clean.includes("?")) return true;

  const triggers = [
    "tell me", "tell us", "walk me", "walk us", "explain", "describe",
    "how would", "how do", "how did", "how can", "how to", "how should", "how",
    "what is", "what are", "what was", "what would", "what do", "what does", "what can", "what",
    "why did", "why would", "why is", "why do", "why should", "why",
    "can you", "could you", "would you", "can i", "can we", "could we",
    "what's", "whats", "have you ever", "have you", "do you", "did you",
    "give me", "give us", "give an", "give a", "give",
    "show me", "show us", "show a", "show an", "show",
    "write a", "write an", "write me", "write",
    "provide a", "provide an", "provide me",
    "design a", "design an", "design",
    "build a", "build an", "build",
    "create a", "create an", "create",
    "generate a", "generate an",
    "construct a", "construct an",
    "implement a", "implement an",
    "difference between", "pros and cons", "experience with", "opinion on"
  ];

  return triggers.some(t => clean.startsWith(t) || clean.includes(` ${t} `) || clean.includes(` ${t}`));
}

export function isCompleteAutoQuestion(line: string): boolean {
  const clean = line.replace(/^them:\s*|^you:\s*|^speaker\s*\d.*:\s*/i, "").trim();
  const wordCount = clean.split(/\s+/).filter(Boolean).length;
  if (!clean || clean.length < 12 || wordCount < 3) return false;
  return isInterviewQuestion(clean);
}

// Component
export function ContextBuffer({ items, onItemsChange, registerFlushCallback, onRecordingStart, onRecordingStop }: ContextBufferProps) {
  const { transcribeAudio, transcribeDualNative, startNativeRecording, stopNativeRecording, captureScreenshot, loading } = useTauri();
  const [isRecording, setIsRecording] = useState(false);

  const deduplicateItems = useCallback((rawItems: ContextItem[]): ContextItem[] => {
    const seenCleanTexts = new Set<string>();
    const result: ContextItem[] = [];

    for (const item of rawItems) {
      if (!item.content || !item.content.trim()) continue;

      if (item.kind !== "Audio") {
        const norm = item.content.trim().toLowerCase();
        if (!seenCleanTexts.has(norm)) {
          seenCleanTexts.add(norm);
          result.push(item);
        }
        continue;
      }

      const rawLines = item.content.split('\n\n').flatMap(b => b.split('\n')).filter(l => l.trim().length > 0);
      const uniqueLines: string[] = [];

      for (const line of rawLines) {
        const clean = line.replace(/^them:\s*|^you:\s*|^speaker\s*\d.*:\s*/i, "").trim().toLowerCase();
        if (clean && !seenCleanTexts.has(clean)) {
          seenCleanTexts.add(clean);
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
  }, []);

  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const speechRecognitionRef = useRef<any>(null);
  const unlistenLiveTranscriptRef = useRef<UnlistenFn | null>(null);
  const micStreamRef = useRef<MediaStream | null>(null);
  const [liveTranscript, setLiveTranscript] = useState<string>("");
  const [flushedLineCount, setFlushedLineCount] = useState<number>(0);
  const flushedLineCountRef = useRef<number>(0);
  const [activeStream, setActiveStream] = useState<MediaStream | null>(null);
  const [textInput, setTextInput] = useState("");
  const [showTextInput, setShowTextInput] = useState(false);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const liveLogBodyRef = useRef<HTMLDivElement>(null);
  const itemListRef = useRef<HTMLDivElement>(null);
  const pendingAutoQuestionRef = useRef<string | null>(null);
  const lastAutoAskedTimeRef = useRef<number>(0);
  const lastTranscriptChangeTimeRef = useRef<number>(Date.now());
  const askedQuestionsSetRef = useRef<Set<string>>(new Set());

  // Track live transcript changes for speech completion debounce
  useEffect(() => {
    lastTranscriptChangeTimeRef.current = Date.now();

    const ctx = (window as any).__interviewContext || {};
    if (!ctx.autoQuestionResponse || !liveTranscript.trim()) return;

    const lines = liveTranscript.split('\n').map(l => l.trim()).filter(l => l.length > 0);
    if (lines.length === 0) return;

    const collectedQuestions: string[] = [];
    
    for (const line of lines) {
      if (isCompleteAutoQuestion(line)) {
        const extractedQuestion = line.replace(/^them:\s*|^you:\s*|^speaker\s*\d.*:\s*/i, "").trim();
        const lowerQ = extractedQuestion.toLowerCase();

        // Avoid re-asking identical or duplicate questions using exact set lookup
        if (lowerQ && !askedQuestionsSetRef.current.has(lowerQ)) {
          if (!collectedQuestions.some(q => q.toLowerCase() === lowerQ)) {
            collectedQuestions.push(extractedQuestion);
          }
        }
      }
    }

    if (collectedQuestions.length > 0) {
      pendingAutoQuestionRef.current = collectedQuestions.join(" ");
    }
  }, [liveTranscript]);

  // Continuous auto-ask dispatcher: waits for 1.2s quiet pause after speech before asking AI
  useEffect(() => {
    const interval = setInterval(() => {
      const ctx = (window as any).__interviewContext || {};
      if (!ctx.autoQuestionResponse) return;

      if (pendingAutoQuestionRef.current) {
        const quietDuration = Date.now() - lastTranscriptChangeTimeRef.current;
        const qToAsk = pendingAutoQuestionRef.current;
        const isEndedWithPunctuation = /[?.!]\s*$/.test(qToAsk);

        // Wait for 1.2s quiet pause OR complete punctuation before firing Auto-Ask!
        if (quietDuration >= 1200 || isEndedWithPunctuation) {
          // Cooldown check: at least 2.5s between auto questions to prevent stream overlap
          if (Date.now() - lastAutoAskedTimeRef.current < 2500) return;

          console.log("[Auto-Ask] Dispatching complete question to AI:", qToAsk);
          if (typeof (window as any).__triggerAutoAskAI === "function") {
            const accepted = (window as any).__triggerAutoAskAI(qToAsk);
            if (accepted) {
              pendingAutoQuestionRef.current = null;
              askedQuestionsSetRef.current.add(qToAsk.trim().toLowerCase());
              lastAutoAskedTimeRef.current = Date.now();
            }
          }
        }
      }
    }, 200);

    return () => clearInterval(interval);
  }, []);

  // Register flush callback to allow parent to flush live transcript into history
  useEffect(() => {
    if (registerFlushCallback) {
      registerFlushCallback(() => {
        const liveLines = liveTranscript.split('\n').filter(l => l.trim() !== "");
        const unflushedLines = liveLines.slice(flushedLineCountRef.current);
        const text = unflushedLines.join('\n').trim();
        
        if (!text) return null;

        const newItem: ContextItem = {
          id: `ctx-${Date.now()}-live-flush`,
          kind: "Audio",
          content: text,
          timestamp: Date.now()
        };
        
        const nextItems = deduplicateItems([...itemsRef.current, newItem]);
        onItemsChange(nextItems);
        flushedLineCountRef.current = liveLines.length;
        setFlushedLineCount(liveLines.length);
        return newItem;
      });
    }
  }, [liveTranscript, registerFlushCallback, onItemsChange, deduplicateItems]);

  // Auto-scroll live log body
  useEffect(() => {
    if (liveLogBodyRef.current) {
      liveLogBodyRef.current.scrollTop = liveLogBodyRef.current.scrollHeight;
    }
  }, [liveTranscript]);

  // Auto-scroll context items list to bottom when new items are added
  useEffect(() => {
    if (itemListRef.current) {
      itemListRef.current.scrollTop = itemListRef.current.scrollHeight;
    }
  }, [items.length]);

  // Keep selectedIds in sync when items are removed
  useEffect(() => {
    setSelectedIds(prev => prev.filter(id => items.some(item => item.id === id)));
  }, [items]);

  // Global hotkey event listener (e.g. Ctrl+Shift+S from anywhere in Windows)
  const isCapturingScreenshotRef = useRef(false);
  useEffect(() => {
    let unlisten: UnlistenFn | null = null;
    listen("trigger_screenshot_capture", () => {
      if (isCapturingScreenshotRef.current) return;
      isCapturingScreenshotRef.current = true;
      handleScreenshot().finally(() => {
        setTimeout(() => {
          isCapturingScreenshotRef.current = false;
        }, 500);
      });
    }).then(fn => {
      unlisten = fn;
    }).catch(err => {
      console.debug("Failed to register screenshot listener:", err);
    });

    return () => {
      if (unlisten) unlisten();
    };
  }, []);

  const [filterTab, setFilterTab] = useState<"all" | "spk1" | "spk2">("all");

  useEffect(() => {
    if (showTextInput) textareaRef.current?.focus();
  }, [showTextInput]);

  // Generate a simple unique id
  const uid = () => `ctx-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

  // Add an item locally
  const addItem = (kind: ContextItem["kind"], content: string) => {
    const newItemId = uid();
    const item: ContextItem = { id: newItemId, kind, content, timestamp: Date.now() };
    onItemsChange([...items, item]);
    setSelectedIds(prev => [...prev, newItemId]);
  };

  // Remove an item
  const removeItem = (id: string) => onItemsChange(items.filter(i => i.id !== id));

  const [topPortal, setTopPortal] = useState<HTMLElement | null>(null);
  const [recordingError, setRecordingError] = useState<string | null>(null);

  useEffect(() => {
    setTopPortal(document.getElementById('top-bar-portal'));
  }, []);

  const itemsRef = useRef(items);
  useEffect(() => {
    itemsRef.current = items;
  }, [items]);

  const isRecordingRef = useRef(isRecording);
  useEffect(() => {
    isRecordingRef.current = isRecording;
  }, [isRecording]);

  const audioChunksRef = useRef<Blob[]>([]);
  const [recordedBytes, setRecordedBytes] = useState(0);
  const [recordingSeconds, setRecordingSeconds] = useState(0);

  useEffect(() => {
    if (!isRecording) {
      setRecordingSeconds(0);
      return;
    }

    const startTime = Date.now();
    setRecordingSeconds(0);

    const interval = setInterval(() => {
      const elapsed = Math.floor((Date.now() - startTime) / 1000);
      setRecordingSeconds(elapsed);
    }, 1000);

    return () => clearInterval(interval);
  }, [isRecording]);

  const formatElapsed = (sec: number) => {
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    const s = sec % 60;
    const pad = (n: number) => n.toString().padStart(2, '0');
    return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
  };

  // Supported MimeType Helper
  const getMimeType = () => {
    if (typeof MediaRecorder === "undefined") return "";
    const candidateTypes = [
      "audio/webm;codecs=opus",
      "audio/webm",
      "audio/mp4",
      "audio/wav",
      "audio/ogg;codecs=opus"
    ];
    for (const t of candidateTypes) {
      if (MediaRecorder.isTypeSupported(t)) return t;
    }
    return "";
  };

  // Flush & Transcribe audio buffer on demand
  const flushAudioBuffer = useCallback(async (isStop = false) => {
    console.log("Flushing audio buffer (isStop =", isStop, ")...");

    // 1. Try native Rust hardware parallel VAD dual-channel audio capture
    try {
      const dualRes = await transcribeDualNative(isStop);
      if (dualRes) {
        const parts: string[] = [];
        const now = Date.now();

        if (dualRes.interviewer_text && dualRes.interviewer_text.trim().length > 0) {
          parts.push(`Them: ${dualRes.interviewer_text.trim()}`);
        }

        if (dualRes.candidate_text && dualRes.candidate_text.trim().length > 0) {
          parts.push(`You: ${dualRes.candidate_text.trim()}`);
        }

        if (parts.length > 0) {
          const combinedContent = parts.join("\n\n");
          const cleanCombined = combinedContent.toLowerCase().replace(/[^a-z]/g, "");
          if (cleanCombined === "themthankyou" || cleanCombined === "youthankyou" || cleanCombined === "thankyou" || cleanCombined.length === 0) {
            audioChunksRef.current = [];
            setRecordedBytes(0);
            return null;
          }

          const newItem: ContextItem = {
            id: `ctx-${now}-recording-${Math.random().toString(36).slice(2, 6)}`,
            kind: "Audio",
            content: combinedContent,
            timestamp: now
          };

          audioChunksRef.current = [];
          setRecordedBytes(0);
          onItemsChange([...itemsRef.current, newItem]);
          setSelectedIds(prev => [...prev, newItem.id]);
          return newItem;
        }
      }
    } catch (err: any) {
      console.warn("Native audio flush error, falling back to web audio:", err);
      const msg = err?.message || String(err);
      if (msg.includes("inactive") || msg.includes("token") || msg.includes("Cloud") || msg.includes("403")) {
        setRecordingError("Cloud Pass token is inactive or expired. Please check Settings → Cloud Pass.");
      }
    }

    // 2. Fallback to browser MediaRecorder chunks if needed
    if (mediaRecorderRef.current && mediaRecorderRef.current.state === "recording") {
      try {
        mediaRecorderRef.current.requestData();
      } catch (e) {
        console.warn("requestData failed:", e);
      }
    }

    await new Promise(r => setTimeout(r, 50));
    if (audioChunksRef.current.length === 0) return null;
    
    const blobType = audioChunksRef.current[0]?.type || getMimeType() || 'audio/webm';
    const fullBlob = new Blob(audioChunksRef.current, { type: blobType });

    if (fullBlob.size === 0) return null;

    try {
      const arrayBuffer = await fullBlob.arrayBuffer();
      const bytes = Array.from(new Uint8Array(arrayBuffer));
      const result = await transcribeAudio(bytes, fullBlob.type);
      
      if (result?.text && result.text.trim().length > 0) {
        const cleanAlpha = result.text.toLowerCase().replace(/[^a-z]/g, "");
        if (cleanAlpha === "thankyou" || cleanAlpha === "thanks" || cleanAlpha === "thanksforwatching" || cleanAlpha === "subtitlesby" || cleanAlpha.length === 0) {
          audioChunksRef.current = [];
          setRecordedBytes(0);
          return null;
        }

        const lines = result.text.trim().split('\n').map(l => l.trim()).filter(l => l.length > 0);
        const now = Date.now();
        const formattedLines = lines.map(line => /^them:|^you:|^speaker/i.test(line) ? line : `You: ${line}`);
        const combinedContent = formattedLines.join("\n\n");

        const newItem: ContextItem = {
          id: `ctx-${now}-fallback-${Math.random().toString(36).slice(2, 6)}`,
          kind: "Audio",
          content: combinedContent,
          timestamp: now
        };

        audioChunksRef.current = [];
        setRecordedBytes(0);
        onItemsChange([...itemsRef.current, newItem]);
        setSelectedIds(prev => [...prev, newItem.id]);
        return newItem;
      }
    } catch (err: any) {
      console.error("Failed to transcribe buffered audio:", err);
      const msg = err?.message || String(err);
      if (msg.includes("inactive") || msg.includes("token") || msg.includes("Cloud") || msg.includes("403")) {
        setRecordingError("Cloud Pass token is inactive or expired. Please check Settings → Cloud Pass.");
        (window as any).__triggerCloudExpiredModal?.();
      }
    }
    return null;
  }, [transcribeDualNative, transcribeAudio, onItemsChange]);

  // Expose to window so AIResponse or global hotkeys can invoke it effortlessly
  useEffect(() => {
    (window as any).__flushAudioBuffer = flushAudioBuffer;
    (window as any).__clearLiveTranscript = () => {
      setLiveTranscript("");
      setFlushedLineCount(0);
      flushedLineCountRef.current = 0;
      pendingAutoQuestionRef.current = null;
      askedQuestionsSetRef.current.clear();
    };
    (window as any).__restartAudioStream = async (newMic?: string, newSpeaker?: string) => {
      if (!isRecordingRef.current) return;
      const targetMic = newMic !== undefined ? newMic : (localStorage.getItem("hackysack_mic_id") || "");
      const targetSpeaker = newSpeaker !== undefined ? newSpeaker : (localStorage.getItem("hackysack_speaker_id") || "");
      console.log("[Audio] Hot-switching audio devices to:", targetMic, targetSpeaker);
      try {
        await startNativeRecording(targetMic, targetSpeaker);
      } catch (e) {
        console.warn("Hot switch native recording failed:", e);
      }
      try {
        if (micStreamRef.current) {
          micStreamRef.current.getTracks().forEach(t => t.stop());
        }
        const audioConstraint = (targetMic && targetMic.trim() !== "" && targetMic !== "default") 
          ? { deviceId: { exact: targetMic } } 
          : true;
        const newStream = await navigator.mediaDevices.getUserMedia({ audio: audioConstraint })
          .catch(() => navigator.mediaDevices.getUserMedia({ audio: true }).catch(() => null));
        micStreamRef.current = newStream;
        if (newStream) setActiveStream(newStream);
      } catch (e) {
        console.warn("Hot switch web mic failed:", e);
      }
    };
  }, [flushAudioBuffer, startNativeRecording]);

  // Toggle recording
  const startContinuousRecording = async () => {
    // Reset live transcript log and archive active response card on new recording
    setLiveTranscript("");
    setFlushedLineCount(0);
    flushedLineCountRef.current = 0;
    pendingAutoQuestionRef.current = null;
    askedQuestionsSetRef.current.clear();
    if (typeof (window as any).__archiveActiveResponse === "function") {
      (window as any).__archiveActiveResponse();
    }

    const savedMic = localStorage.getItem("hackysack_mic_id") || "";
    const savedSpeaker = localStorage.getItem("hackysack_speaker_id") || "";
    
    const audioConstraint: boolean | MediaTrackConstraints = 
      (savedMic && savedMic.trim() !== "" && savedMic !== "default") 
        ? { deviceId: { exact: savedMic } } 
        : true;

    try {
      console.log("Starting native WASAPI loopback & mic background capture...");
      
      // 1. Start Native background WASAPI loopback
      try {
        await startNativeRecording(savedMic, savedSpeaker);
      } catch (nativeErr) {
        console.warn("Native recorder start failed:", nativeErr);
      }

      // 2. Start local mic stream for live waveform visualizer & fallback MediaRecorder
      let micStream: MediaStream | null = null;
      try {
        micStream = await navigator.mediaDevices.getUserMedia({ audio: audioConstraint });
      } catch (micErr) {
        try {
          micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
        } catch (e2) {
          console.warn("Local webview mic stream unavailable (native capture running):", e2);
        }
      }

      micStreamRef.current = micStream;
      if (micStream) {
        setActiveStream(micStream);
      }
      setIsRecording(true);
      isRecordingRef.current = true;
      if (onRecordingStart) {
        onRecordingStart();
      }
      audioChunksRef.current = [];
      setRecordedBytes(0);

      // Start Web MediaRecorder locally as backup (if webview stream exists)
      if (micStream) {
        try {
          const mimeType = getMimeType();
          const recorder = new MediaRecorder(micStream, mimeType ? { mimeType } : undefined);
          mediaRecorderRef.current = recorder;
          recorder.ondataavailable = (e) => {
            if (e.data && e.data.size > 0) {
              audioChunksRef.current.push(e.data);
              setRecordedBytes(prev => prev + e.data.size);
            }
          };
          recorder.start(500);
        } catch (recErr) {
          console.warn("Web MediaRecorder backup skipped:", recErr);
        }
      }

      // Start live transcription event listener
      if (unlistenLiveTranscriptRef.current) {
        unlistenLiveTranscriptRef.current();
      }
      
      unlistenLiveTranscriptRef.current = await listen("live-transcript", (event: any) => {
        if (!isRecordingRef.current) return;
        
        try {
          const payload = event.payload;
          console.log("[Live Transcript Event Received]", payload);
          let snippet = "";
          
          if (payload.speaker === "them" && payload.text) {
            snippet += `Them: ${payload.text.trim()}\n`;
          } else if (payload.speaker === "you" && payload.text) {
            snippet += `You: ${payload.text.trim()}\n`;
          }
          
          if (snippet) {
            setLiveTranscript(prev => {
              if (!prev) return snippet.trim();

              const prevLines = prev.split('\n').map(l => l.trim()).filter(Boolean);
              const lastLine = prevLines[prevLines.length - 1] || "";
              const newLines = snippet.trim().split('\n').map(l => l.trim()).filter(Boolean);

              let resultLines = [...prevLines];

              for (const newLine of newLines) {
                const cleanNew = newLine.replace(/^them:\s*|^you:\s*|^speaker\s*\d.*:\s*/i, "").trim();
                const cleanLast = lastLine.replace(/^them:\s*|^you:\s*|^speaker\s*\d.*:\s*/i, "").trim();

                if (!cleanNew) continue;
                if (cleanLast.toLowerCase() === cleanNew.toLowerCase()) continue;
                if (cleanNew.includes("invalid_api_key") || cleanNew.includes("openai.com") || cleanNew.includes("invalid_request_error")) continue;

                const isLastThem = /^them:/i.test(lastLine);
                const isLastYou = /^you:/i.test(lastLine);
                const isNewThem = /^them:/i.test(newLine);
                const isNewYou = /^you:/i.test(newLine);

                const lastHasPunctuation = /[.!?]$/.test(cleanLast);

                if ((isLastThem && isNewThem) || (isLastYou && isNewYou)) {
                  // If the previous sentence finished with punctuation (. ! ?), start a new line / new chat box!
                  if (lastHasPunctuation && cleanNew.length > 3 && !cleanNew.toLowerCase().startsWith(cleanLast.toLowerCase())) {
                    resultLines.push(newLine);
                  } else {
                    // Update active in-progress sentence
                    resultLines[resultLines.length - 1] = newLine;
                  }
                } else {
                  // Speaker changed -> start a new line / new chat box!
                  resultLines.push(newLine);
                }
              }
              return resultLines.join('\n').trim();
            });
          }
        } catch (e: any) {
          console.warn("Live dual transcription error:", e);
        }
      });
    } catch (err) {
      console.error("Audio recording completely failed:", err);
      setIsRecording(false);
      alert("Failed to start audio recording.");
    }
  };

  const stopContinuousRecording = async () => {
    setIsRecording(false);
    
    if (unlistenLiveTranscriptRef.current) {
      unlistenLiveTranscriptRef.current();
      unlistenLiveTranscriptRef.current = null;
    }

    if (speechRecognitionRef.current) {
      try { speechRecognitionRef.current.stop(); } catch (e) {}
      speechRecognitionRef.current = null;
    }

    // Archive response window active stream/card so history items remain visible
    if (typeof (window as any).__archiveActiveResponse === "function") {
      (window as any).__archiveActiveResponse();
    } else if (typeof (window as any).__clearAutoResponse === "function") {
      (window as any).__clearAutoResponse();
    }

    // Flush live transcript text into context items with zero duplicates
    const liveLines = liveTranscript.split('\n').filter(l => l.trim() !== "");
    if (liveLines.length > 0) {
      const newAudioItems: ContextItem[] = liveLines.map((line, idx) => {
        const trimmed = line.trim();
        const formatted = /^them:|^you:|^speaker/i.test(trimmed) ? trimmed : `You: ${trimmed}`;
        return {
          id: `ctx-${Date.now()}-${idx}-${Math.random().toString(36).slice(2, 6)}`,
          kind: "Audio" as const,
          content: formatted,
          timestamp: Date.now()
        };
      });

      const nextItems = deduplicateItems([...itemsRef.current, ...newAudioItems]);
      onItemsChange(nextItems);
    }

    setLiveTranscript("");
    setFlushedLineCount(0);
    flushedLineCountRef.current = 0;
    pendingAutoQuestionRef.current = null;

    if (mediaRecorderRef.current && mediaRecorderRef.current.state !== "inactive") {
      try { mediaRecorderRef.current.stop(); } catch (e) {}
    }

    if (micStreamRef.current) {
      micStreamRef.current.getTracks().forEach(t => t.stop());
      micStreamRef.current = null;
    }

    setActiveStream(null);

    // Trigger onRecordingStop callback if provided (switches to Recordings & Overview view)
    if (onRecordingStop) {
      onRecordingStop();
    }
  };

  const handleRecordToggle = () => {
    if (isRecording) {
      stopContinuousRecording();
    } else {
      startContinuousRecording();
    }
  };



  // Screenshot
  const handleScreenshot = async () => {
    try {
      const res: any = await captureScreenshot();
      const content = res?.base64_image || res?.text_summary || "Active Screen Snapshot — Please solve the coding problem visible on screen.";
      const newItemId = uid();
      const item: ContextItem = { id: newItemId, kind: "Screenshot", content, timestamp: Date.now() };
      onItemsChange([...itemsRef.current, item]);
      setSelectedIds(prev => [...prev, newItemId]);

      // Automatically trigger AI answer for this captured screenshot
      if (typeof (window as any).__askAIWithItems === "function") {
        setTimeout(() => {
          (window as any).__askAIWithItems([item]);
        }, 120);
      }
    } catch (e) {
      console.error("Screenshot capture error:", e);
    }
  };

  // Submit pasted text
  const handleAddText = () => {
    const raw = textInput.trim();
    if (!raw) return;
    const newItemId = uid();
    const item: ContextItem = { id: newItemId, kind: "Text", content: raw, timestamp: Date.now() };
    onItemsChange([...itemsRef.current, item]);
    setSelectedIds(prev => [...prev, newItemId]);
    setTextInput("");
    setShowTextInput(false);

    // Automatically trigger AI answer for this pasted text
    if (typeof (window as any).__askAIWithItems === "function") {
      setTimeout(() => {
        (window as any).__askAIWithItems([item]);
      }, 120);
    }
  };

  const handleClearAll = () => {
    onItemsChange([]);
    setSelectedIds([]);
    setLiveTranscript("");
    setFlushedLineCount(0);
    flushedLineCountRef.current = 0;
    pendingAutoQuestionRef.current = null;
    askedQuestionsSetRef.current.clear();
    lastAutoAskedTimeRef.current = 0;
    if (typeof (window as any).__resetAIResponse === "function") {
      (window as any).__resetAIResponse();
    }
  };

  // Item Selection Helpers
  const toggleSelectItem = (id: string, e?: React.MouseEvent) => {
    if (e) e.stopPropagation();
    setSelectedIds(prev =>
      prev.includes(id) ? prev.filter(item => item !== id) : [...prev, id]
    );
  };

  const selectAllItems = () => {
    if (selectedIds.length === items.length) {
      setSelectedIds([]);
    } else {
      setSelectedIds(items.map(i => i.id));
    }
  };

  const sendItemToAI = async (item: ContextItem, e?: React.MouseEvent) => {
    if (e) e.stopPropagation();
    if (typeof (window as any).__askAIWithItems === "function") {
      await (window as any).__askAIWithItems([item]);
    }
  };

  const sendSelectedToAI = async () => {
    const selectedItems = items.filter(i => selectedIds.includes(i.id));
    if (selectedItems.length === 0) return;

    // Use the direct askAI path via window helper exposed by AIResponse
    if (typeof (window as any).__askAIWithItems === "function") {
      await (window as any).__askAIWithItems(selectedItems);
    }
  };

  return (
    <div className={styles.wrapper}>
      {/* Header */}
      <div className={styles.header}>
        <span className={styles.title}>Context Buffer</span>
        <div className={styles.headerRight}>
          {items.length > 0 && (
            <button
              className="btn btn-ghost"
              style={{ padding: "2px 6px", fontSize: "11px" }}
              onClick={selectAllItems}
              title={selectedIds.length === items.length ? "Deselect All" : "Select All"}
            >
              {selectedIds.length === items.length ? <CheckSquare size={12} /> : <Square size={12} />}
              {selectedIds.length === items.length ? "Deselect All" : "Select All"}
            </button>
          )}
          <button
            id="btn-clear-context"
            className="btn btn-ghost"
            style={{ padding: "4px 10px", fontSize: "12px" }}
            onClick={handleClearAll}
            title="Clear Context Buffer (F8)"
          >
            <Trash2 size={12} /> Clear (F8)
          </button>
        </div>
      </div>

      {/* Action Buttons */}
      {topPortal ? createPortal(
        <div style={{ display: "flex", alignItems: "center", gap: "8px", marginTop: "2px", marginBottom: "2px" }}>
          <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
            <button
              id="btn-record"
              className={`btn ${isRecording ? "btn-record" : "btn-ghost"}`}
              onClick={handleRecordToggle}
              disabled={loading}
              title={isRecording ? "Stop & transcribe" : "Record audio"}
            >
              {isRecording ? <MicOff size={14} /> : <Mic size={14} />}
              {isRecording ? "Stop (F9)" : "Record (F9)"}
            </button>
            {isRecording && <Waveform stream={activeStream} />}
            {isRecording && (
              <div style={{ display: 'flex', alignItems: 'center', gap: '5px', fontSize: '11px', color: '#ef4444', fontFamily: 'monospace', fontWeight: 600, padding: '2px 6px', borderRadius: 4, background: 'rgba(239,68,68,0.1)', border: '1px solid rgba(239,68,68,0.25)' }}>
                <span className="animate-pulse" style={{ width: '6px', height: '6px', borderRadius: '50%', background: '#ef4444', display: 'inline-block' }} />
                <span>{formatElapsed(recordingSeconds)}</span>
              </div>
            )}
          </div>

          <button
            id="btn-screenshot"
            className="btn btn-ghost"
            onClick={handleScreenshot}
            disabled={loading}
            title="Capture screenshot"
          >
            <Camera size={14} /> Screenshot (F10)
          </button>

          <button
            id="btn-paste-text"
            className="btn btn-ghost"
            onClick={() => setShowTextInput(v => !v)}
            title="Paste text or a question"
          >
            <Type size={14} /> Paste Text
          </button>
        </div>,
        topPortal
      ) : null}

      {/* Real-Time Live Conversation Log */}
      {isRecording && (
        <div className={styles.liveLogPanel}>
          <div className={styles.liveLogHeader}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
              <Mic size={12} className="animate-pulse" style={{ color: '#ef4444' }} />
              <span className={styles.liveLogTitle}>LIVE CONVERSATION LOG</span>
              <span className="badge badge-red" style={{ fontSize: '10px' }}>Recording</span>
            </div>
          </div>

          <div ref={liveLogBodyRef} className={styles.liveLogBody}>
            {(() => {
              const liveLines = liveTranscript
                .split('\n')
                .map(l => l.trim())
                .filter(l => l.length > 0);

              if (liveLines.length === 0) {
                return (
                  <div className={styles.liveLogEmpty}>
                    <span className={styles.pulseDot} />
                    <span>Listening for audio...</span>
                  </div>
                );
              }

              type ConversationalBubble = {
                id: string;
                speaker: "Them" | "You" | "Other";
                text: string;
                isQuestion: boolean;
                isFlushed: boolean;
              };

              const bubbles: ConversationalBubble[] = [];
              liveLines.forEach((line, lineIdx) => {
                const isSpk1 = /^them:|speaker\s*1|interviewer/i.test(line);
                const isSpk2 = /^you:|speaker\s*2|candidate/i.test(line);
                const rawText = line.replace(/^them:\s*|^you:\s*|^speaker\s*\d.*:\s*/i, "").trim();
                const isFlushed = lineIdx < flushedLineCount;

                if (!rawText) return;

                const speaker = isSpk1 ? "Them" : isSpk2 ? "You" : "Other";

                // Split line into individual sentences/questions if multiple exist
                const sentences = rawText
                  .split(/(?<=[.!?])\s+/)
                  .map(s => s.trim())
                  .filter(s => s.length > 0);

                sentences.forEach((subText, subIdx) => {
                  if (!subText || !/[a-zA-Z0-9]/.test(subText)) return;

                  const normSub = subText.toLowerCase().replace(/[^a-z0-9]/g, "");
                  if (!normSub) return;

                  // Check if this sentence/question was already rendered in an existing bubble
                  const existingIdx = bubbles.findIndex(
                    b => b.speaker === speaker && b.text.toLowerCase().replace(/[^a-z0-9]/g, "") === normSub
                  );

                  if (existingIdx !== -1) {
                    // Update existing bubble with refined text if longer
                    if (subText.length > bubbles[existingIdx].text.length) {
                      bubbles[existingIdx].text = subText;
                      bubbles[existingIdx].isQuestion = isInterviewQuestion(subText);
                    }
                    return; // Prevents duplicate chat box creation!
                  }

                  const isQ = isInterviewQuestion(subText);
                  bubbles.push({
                    id: `bbl-${lineIdx}-${subIdx}-${subText.slice(0, 10)}`,
                    speaker,
                    text: subText,
                    isQuestion: isQ,
                    isFlushed
                  });
                });
              });

              return bubbles.map((bubble, idx) => {
                return (
                  <div
                    key={bubble.id || idx}
                    style={{ 
                      opacity: bubble.isFlushed ? 0.45 : 1.0, 
                      filter: bubble.isFlushed ? 'grayscale(80%)' : 'none',
                      transition: 'all 0.3s ease' 
                    }}
                    className={
                      bubble.speaker === "Them"
                        ? `${styles.liveLogBubble} ${styles.liveLogBubbleSpk1}`
                        : bubble.speaker === "You"
                        ? `${styles.liveLogBubble} ${styles.liveLogBubbleSpk2}`
                        : styles.liveLogBubble
                    }
                  >
                    <div className={styles.liveLogBubbleHeader}>
                      {bubble.speaker === "Them" ? (
                        <span className={styles.badgeSpeaker1}>
                          <UserCheck size={10} /> Them
                        </span>
                      ) : bubble.speaker === "You" ? (
                        <span className={styles.badgeSpeaker2}>
                          <Mic size={10} /> You
                        </span>
                      ) : (
                        <span className="badge badge-gray" style={{ fontSize: '10px' }}>Live Speech</span>
                      )}
                    </div>
                    <div className={styles.liveLogBubbleText}>
                      {bubble.text}
                    </div>
                  </div>
                );
              });
            })()}
          </div>
        </div>
      )}

      {/* Paste Text Panel */}
      {showTextInput && (
        <div className={`${styles.textPanel} animate-fadeIn`}>
          <textarea
            ref={textareaRef}
            className="input"
            placeholder="Paste the interview question, job description, or any text here..."
            value={textInput}
            onChange={e => setTextInput(e.target.value)}
            onKeyDown={e => {
              if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) handleAddText();
              if (e.key === "Escape") setShowTextInput(false);
            }}
            rows={4}
          />
          <div className={styles.textActions}>
            <span style={{ color: "var(--text-muted)", fontSize: "11px" }}>Ctrl+Enter to add</span>
            <button className="btn btn-primary" onClick={handleAddText}>Add to Buffer</button>
          </div>
        </div>
      )}

      {/* Speaker Filter & Selection Toolbar */}
      {!isRecording && items.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '6px', padding: '4px 0', borderBottom: '1px solid rgba(255,255,255,0.06)' }}>
            <button
              className={`btn ${filterTab === 'all' ? 'btn-primary' : 'btn-ghost'}`}
              style={{ fontSize: '11px', padding: '3px 8px' }}
              onClick={() => setFilterTab('all')}
            >
              All ({items.length})
            </button>
            <button
              className={`btn ${filterTab === 'spk1' ? 'btn-primary' : 'btn-ghost'}`}
              style={{ fontSize: '11px', padding: '3px 8px', color: filterTab === 'spk1' ? '#ffffff' : '#c084fc' }}
              onClick={() => setFilterTab('spk1')}
            >
              Them ({items.filter(i => /them:|speaker\s*1|interviewer/i.test(i.content)).length})
            </button>
            <button
              className={`btn ${filterTab === 'spk2' ? 'btn-primary' : 'btn-ghost'}`}
              style={{ fontSize: '11px', padding: '3px 8px', color: filterTab === 'spk2' ? '#ffffff' : '#60a5fa' }}
              onClick={() => setFilterTab('spk2')}
            >
              You ({items.filter(i => /you:|speaker\s*2|candidate/i.test(i.content)).length})
            </button>
          </div>

          {selectedIds.length > 0 && (
            <div className={styles.selectionBar}>
              <span style={{ fontSize: '11px', color: '#e9d5ff', fontWeight: 600 }}>
                {selectedIds.length} item{selectedIds.length !== 1 ? 's' : ''} selected
              </span>
              <button
                className={styles.sendSelectedBtn}
                onClick={sendSelectedToAI}
                title="Send selected recordings to AI"
              >
                <Sparkles size={12} /> Send Selected to AI
              </button>
            </div>
          )}
        </div>
      )}

      {/* Error Alert in Context Buffer */}
      {recordingError && (
        <div style={{
          background: 'rgba(239, 68, 68, 0.15)',
          border: '1px solid rgba(239, 68, 68, 0.4)',
          borderRadius: '6px',
          padding: '8px 10px',
          marginBottom: '8px',
          fontSize: '11.5px',
          color: '#fca5a5',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: '6px'
        }}>
          <span>⚠️ {recordingError}</span>
          <button
            className="btn btn-ghost"
            style={{ padding: '2px 5px', fontSize: '10px' }}
            onClick={() => setRecordingError(null)}
            title="Dismiss"
          >
            ✕
          </button>
        </div>
      )}

      {/* Context Items List */}
      <div ref={itemListRef} className={styles.itemList} style={{ display: isRecording ? 'none' : 'flex' }}>
        {items.length === 0 ? (
          <div className={styles.empty}>
            <p>No transcriptions yet</p>
            <p>Record audio, take a screenshot, or paste text to build your context.</p>
          </div>
        ) : (
          items
            .filter(item => {
              if (filterTab === 'spk1') return /them:|speaker\s*1|interviewer/i.test(item.content);
              if (filterTab === 'spk2') return /you:|speaker\s*2|candidate/i.test(item.content);
              return true;
            })
            .map((item, i) => {
            const isSelected = selectedIds.includes(item.id);

            let cardClass = `${styles.item} animate-slideIn`;
            if (isSelected) {
              cardClass += ` ${styles.itemSelected}`;
            }

            return (
              <div
                key={item.id}
                className={cardClass}
                style={{ animationDelay: `${i * 40}ms` }}
                onClick={() => toggleSelectItem(item.id)}
              >
                <div className={styles.itemHeader}>
                  <input
                    type="checkbox"
                    className={styles.itemCheckbox}
                    checked={isSelected}
                    onChange={() => toggleSelectItem(item.id)}
                    onClick={(e) => e.stopPropagation()}
                  />

                  {item.kind === "Audio" ? (
                    <span className="badge badge-purple" style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                      <Mic size={11} /> Audio Recording
                    </span>
                  ) : (
                    <span className={`badge ${kindColor[item.kind]}`}>
                      {kindIcon[item.kind]} {item.kind}
                    </span>
                  )}

                  <span className={styles.timestamp}>
                    <Clock size={10} />
                    {new Date(item.timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                  </span>
                  <button
                    className={styles.removeBtn}
                    onClick={(e) => {
                      e.stopPropagation();
                      removeItem(item.id);
                    }}
                    title="Remove"
                  >✕</button>
                </div>

                <div className={styles.itemContent}>
                  {item.content.startsWith("data:image/") ? (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                      <img
                        src={item.content}
                        alt="Screen Snapshot"
                        style={{ width: '100%', maxHeight: '140px', objectFit: 'contain', background: 'rgba(0,0,0,0.4)', borderRadius: '4px', border: '1px solid rgba(255,255,255,0.1)' }}
                      />
                      <span style={{ fontSize: '11px', color: '#93c5fd', fontStyle: 'italic' }}>
                        Active Screen Snapshot — Visual Context
                      </span>
                    </div>
                  ) : (
                    item.content.split('\n\n').map((block, bIdx) => {
                      const isThem = /^them:/i.test(block.trim());
                      const isYou = /^you:/i.test(block.trim());
                      const text = block.replace(/^them:\s*|^you:\s*/i, '').trim();

                      return (
                        <div key={bIdx} style={{ marginTop: bIdx > 0 ? '8px' : 0, display: 'flex', flexDirection: 'column', gap: '2px' }}>
                          {isThem ? (
                            <span className={styles.badgeSpeaker1} style={{ alignSelf: 'flex-start' }}>
                              <UserCheck size={10} /> Them
                            </span>
                          ) : isYou ? (
                            <span className={styles.badgeSpeaker2} style={{ alignSelf: 'flex-start' }}>
                              <Mic size={10} /> You
                            </span>
                          ) : null}
                          <span style={{ fontSize: '12px', color: 'var(--text-primary)', lineHeight: 1.5 }}>
                            {text}
                          </span>
                        </div>
                      );
                    })
                  )}
                </div>

                <button
                  className={styles.askAiBtn}
                  onClick={(e) => sendItemToAI(item, e)}
                  title="Generate AI response for this transcript item"
                >
                  <Sparkles size={11} /> Send to AI
                </button>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
