import { useState, useEffect, useCallback, useRef } from "react";
import { createPortal } from "react-dom";
import { Key, Cloud, FlaskConical, Settings, X, Check, Save, ShieldCheck, ShieldOff, Pin, PinOff, Sun, Moon, MousePointer, Mic, Volume2, FileText, HelpCircle, BookOpen, Briefcase, Brain, ExternalLink, Minus, Square, RefreshCw } from "lucide-react";
import { open as shellOpen } from "@tauri-apps/plugin-shell";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { invoke } from "@tauri-apps/api/core";
import { check } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import { useTauri } from "../hooks/useTauri";
import { encryptSecret, decryptSecret } from "../utils/crypto";
import { CloudAuthModal } from "./CloudAuthModal";
import { DonateModal } from "./DonateModal";
import logoUrl from "../assets/logo.webp";
import styles from "./Toolbar.module.css";

interface ToolbarProps {
  onPingTest: () => void;
  isClickThrough: boolean;
  onToggleClickThrough: () => void;
  activeView?: "live" | "recordings";
  onToggleView?: () => void;
  appOpacity: number;
  onOpacityChange: (e: React.ChangeEvent<HTMLInputElement>) => void;
  showOverviewPrompt?: boolean;
  onToggleOverviewPrompt?: () => void;
  onOpenOnboarding?: () => void;
  forceOpenCloudModal?: boolean;
  onCloudModalClosed?: () => void;
}

export function Toolbar({ onPingTest, isClickThrough, onToggleClickThrough, activeView, onToggleView, appOpacity, onOpacityChange, showOverviewPrompt: propShowOverviewPrompt, onToggleOverviewPrompt, onOpenOnboarding, forceOpenCloudModal, onCloudModalClosed }: ToolbarProps) {
  const { setApiKey, ping, setScreenProtection, setAlwaysOnTop, loading, parseDocument, saveContextDocument, openFilePath, getSecureKey } = useTauri();
  const [showSettings, setShowSettings] = useState(false);
  const [showCloudModal, setShowCloudModal] = useState(false);
  const [showDonateModal, setShowDonateModal] = useState(false);
  const [isCloudMode, setIsCloudMode] = useState<boolean>(false);
  const [apiKeyInput, setApiKeyInput] = useState("");

  const checkCloudMode = useCallback(async () => {
    try {
      const res: any = await invoke("get_cloud_config");
      const isEnabled = !!res.enabled && !!res.hasToken;
      setIsCloudMode(isEnabled);
      localStorage.setItem("hackysack_cloud_enabled", isEnabled ? "true" : "false");
      if (res.jwt) {
        localStorage.setItem("hackysack_cloud_jwt", encryptSecret(res.jwt));
      } else if (!isEnabled) {
        localStorage.removeItem("hackysack_cloud_jwt");
      }
    } catch {
      setIsCloudMode(false);
      localStorage.setItem("hackysack_cloud_enabled", "false");
    }
  }, []);

  useEffect(() => {
    checkCloudMode();
    window.addEventListener("focus", checkCloudMode);
    (window as any).__closeCloudModal = () => {
      setShowCloudModal(false);
      if (onCloudModalClosed) onCloudModalClosed();
      checkCloudMode();
    };
    return () => {
      window.removeEventListener("focus", checkCloudMode);
      delete (window as any).__closeCloudModal;
    };
  }, [checkCloudMode, onCloudModalClosed]);
  const [transcriptionKeyInput, setTranscriptionKeyInput] = useState("");
  const [providerInput, setProviderInput] = useState("groq");
  const [keySaved, setKeySaved] = useState(false);

  // Individual API Field Verification States
  const [aiKeyVerifying, setAiKeyVerifying] = useState(false);
  const [aiKeyStatus, setAiKeyStatus] = useState<{ type: "success" | "error"; message: string } | null>(null);

  const [speechKeyVerifying, setSpeechKeyVerifying] = useState(false);
  const [speechKeyStatus, setSpeechKeyStatus] = useState<{ type: "success" | "error"; message: string } | null>(null);



  // In-App Auto Update States
  const [updateChecking, setUpdateChecking] = useState(false);
  const [hasAvailableUpdate, setHasAvailableUpdate] = useState<string | null>(null);
  const [updateStatus, setUpdateStatus] = useState<{
    type: "idle" | "latest" | "available" | "downloading" | "error";
    message?: string;
    version?: string;
    body?: string;
  } | null>(null);
  const [downloadProgress, setDownloadProgress] = useState<number | null>(null);
  const [pingResult, setPingResult] = useState<string | null>(null);
  const [isProtected, setIsProtected] = useState(true);
  const [isAlwaysOnTop, setIsAlwaysOnTop] = useState(true);
  const [theme, setTheme] = useState<"dark" | "light">("dark");
  const [mics, setMics] = useState<MediaDeviceInfo[]>([]);
  const [speakers, setSpeakers] = useState<MediaDeviceInfo[]>([]);
  const [selectedMicId, setSelectedMicId] = useState<string>("");
  const [selectedSpeakerId, setSelectedSpeakerId] = useState<string>("");
  // Interview context
  const [resumeText, setResumeText] = useState("");
  const [jobDescText, setJobDescText] = useState("");
  const [extraContext, setExtraContext] = useState("");
  const [autoQuestionResponse, setAutoQuestionResponse] = useState(false);
  const [codingOAMode, setCodingOAMode] = useState(
    localStorage.getItem("hackysack_coding_oa_mode") === "true"
  );
  const [codingOALang, setCodingOALang] = useState(
    localStorage.getItem("hackysack_coding_oa_lang") || "Python 3"
  );
  const [showOverviewLocal, setShowOverviewLocal] = useState(
    localStorage.getItem("hackysack_show_overview") !== "false"
  );
  const showOverviewPrompt = propShowOverviewPrompt ?? showOverviewLocal;

  const handleToggleOverviewPrompt = () => {
    if (onToggleOverviewPrompt) {
      onToggleOverviewPrompt();
    } else {
      const next = !showOverviewLocal;
      setShowOverviewLocal(next);
      localStorage.setItem("hackysack_show_overview", String(next));
    }
  };
  const [showHotkeys, setShowHotkeys] = useState(false);
  const [expandResume, setExpandResume] = useState(false);
  const [expandJD, setExpandJD] = useState(false);
  const [expandExtra, setExpandExtra] = useState(false);
  const [showContext, setShowContext] = useState(false);

  const settingsPanelRef = useRef<HTMLDivElement>(null);
  const settingsBtnRef = useRef<HTMLButtonElement>(null);
  const contextPanelRef = useRef<HTMLDivElement>(null);
  const contextBtnRef = useRef<HTMLButtonElement>(null);

  // Auto-close Context and Settings menus when clicking outside or pressing Escape
  useEffect(() => {
    if (!showSettings && !showContext) return;

    const handlePointerDown = (e: MouseEvent) => {
      const target = e.target as Node;

      if (
        showSettings &&
        settingsPanelRef.current &&
        !settingsPanelRef.current.contains(target) &&
        settingsBtnRef.current &&
        !settingsBtnRef.current.contains(target)
      ) {
        setShowSettings(false);
      }

      if (
        showContext &&
        contextPanelRef.current &&
        !contextPanelRef.current.contains(target) &&
        contextBtnRef.current &&
        !contextBtnRef.current.contains(target)
      ) {
        setShowContext(false);
      }
    };

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        if (showSettings) setShowSettings(false);
        if (showContext) setShowContext(false);
      }
    };

    window.addEventListener("mousedown", handlePointerDown);
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("mousedown", handlePointerDown);
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [showSettings, showContext]);

  // Auto silent check for updates on app launch
  useEffect(() => {
    const checkUpdateOnLaunch = async () => {
      try {
        const update = await check();
        if (update?.available) {
          setHasAvailableUpdate(update.version);
          setUpdateStatus({
            type: "available",
            version: update.version,
            message: `v${update.version} is available!`
          });
        }
      } catch (e) {
        console.debug("Silent launch update check skipped:", e);
      }
    };

    const timer = setTimeout(() => {
      checkUpdateOnLaunch();
    }, 2000);

    return () => clearTimeout(timer);
  }, []);

  // Track which field is in "file mode" vs "manual text mode"
  const [resumeFileName, setResumeFileName] = useState<string | null>(
    localStorage.getItem("hackysack_resume_filename") || null
  );
  const [resumeFilePath, setResumeFilePath] = useState<string | null>(
    localStorage.getItem("hackysack_resume_filepath") || null
  );
  const [jobDescFileName, setJobDescFileName] = useState<string | null>(
    localStorage.getItem("hackysack_job_desc_filename") || null
  );
  const [jobDescFilePath, setJobDescFilePath] = useState<string | null>(
    localStorage.getItem("hackysack_job_desc_filepath") || null
  );
  const [extraFileName, setExtraFileName] = useState<string | null>(
    localStorage.getItem("hackysack_extra_filename") || null
  );
  const [extraFilePath, setExtraFilePath] = useState<string | null>(
    localStorage.getItem("hackysack_extra_filepath") || null
  );

  const refreshDevices = useCallback(async () => {
    try {
      const nativeDevices = await invoke<{ id: string; name: string; is_input: boolean }[]>("get_audio_devices");
      if (nativeDevices && nativeDevices.length > 0) {
        const inputDevs = nativeDevices.filter(d => d.is_input).map(d => ({ deviceId: d.id, label: d.name, kind: "audioinput" } as MediaDeviceInfo));
        const outputDevs = nativeDevices.filter(d => !d.is_input).map(d => ({ deviceId: d.id, label: d.name, kind: "audiooutput" } as MediaDeviceInfo));
        setMics(inputDevs);
        setSpeakers(outputDevs);
        return;
      }
    } catch (e) {
      console.debug("Native device enumeration fallback:", e);
    }

    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      setMics(devices.filter(d => d.kind === "audioinput"));
      setSpeakers(devices.filter(d => d.kind === "audiooutput"));
    } catch (err) {
      console.error("Failed to enumerate devices:", err);
    }
  }, []);

  // Auto-load saved API Key, Provider, and Theme from localStorage on mount
  useEffect(() => {
    const savedKey = decryptSecret(localStorage.getItem("hackysack_api_key"));
    const savedTransKey = decryptSecret(localStorage.getItem("hackysack_transcription_key"));
    const savedProvider = localStorage.getItem("hackysack_provider") || "groq";
    const savedTheme = (localStorage.getItem("hackysack_theme") as "dark" | "light") || "dark";

    setTheme(savedTheme);
    document.documentElement.setAttribute("data-theme", savedTheme);

    if (savedProvider) setProviderInput(savedProvider);
    if (savedTransKey) setTranscriptionKeyInput(savedTransKey);
    if (savedKey) {
      setApiKeyInput(savedKey);
      setApiKey(savedKey, savedProvider, savedTransKey || undefined);
    } else {
      getSecureKey("ai_api_key").then((vaultKey: string | null) => {
        if (vaultKey) {
          setApiKeyInput(vaultKey);
          setApiKey(vaultKey, savedProvider, savedTransKey || undefined);
        }
      }).catch((e: any) => console.debug("Keyring mount lookup skipped:", e));
    }

    // Load saved device IDs
    const savedMicId = localStorage.getItem("hackysack_mic_id") || "";
    const savedSpeakerId = localStorage.getItem("hackysack_speaker_id") || "";
    setSelectedMicId(savedMicId);
    setSelectedSpeakerId(savedSpeakerId);

    // Load interview context settings
    setResumeText(localStorage.getItem("hackysack_resume") || "");
    setJobDescText(localStorage.getItem("hackysack_job_desc") || "");
    setExtraContext(localStorage.getItem("hackysack_extra_context") || "");
    setAutoQuestionResponse(localStorage.getItem("hackysack_auto_question") === "true");

    // Sync cloud mode status from backend keyring on mount
    invoke<any>("get_cloud_config").then((cfg) => {
      setIsCloudMode(Boolean(cfg && cfg.enabled));
    }).catch(e => {
      console.debug("Cloud config sync skipped:", e);
      setIsCloudMode(false);
    });

    // Refresh audio input/output devices list asynchronously without delaying initial UI load
    setTimeout(() => {
      refreshDevices();
    }, 500);
  }, [setApiKey, refreshDevices]);

  // Sync window.__interviewContext whenever settings change
  useEffect(() => {
    (window as any).__interviewContext = {
      resume: resumeText,
      jobDesc: jobDescText,
      extra: extraContext,
      autoQuestionResponse,
    };
  }, [resumeText, jobDescText, extraContext, autoQuestionResponse]);

  // Keyboard hotkey (Ctrl+Alt+C) to toggle Click-Through mouse pass
  useEffect(() => {
    const handleGlobalKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.altKey && e.code === "KeyC") {
        e.preventDefault();
        onToggleClickThrough();
      }
    };
    window.addEventListener("keydown", handleGlobalKeyDown);
    return () => window.removeEventListener("keydown", handleGlobalKeyDown);
  }, [onToggleClickThrough]);

  const handleToggleTheme = () => {
    const nextTheme = theme === "dark" ? "light" : "dark";
    setTheme(nextTheme);
    document.documentElement.setAttribute("data-theme", nextTheme);
    localStorage.setItem("hackysack_theme", nextTheme);
  };

  // Auto-enable Always-On-Top when Click-Through mode is activated
  useEffect(() => {
    if (isClickThrough && !isAlwaysOnTop) {
      setAlwaysOnTop(true).then((res) => {
        if (res !== null) setIsAlwaysOnTop(res);
      });
    }
  }, [isClickThrough, isAlwaysOnTop, setAlwaysOnTop]);

  const handleToggleStealth = async () => {
    const nextState = !isProtected;
    const res = await setScreenProtection(nextState);
    if (res) {
      setIsProtected(res.protected);
    }
  };

  const handleTogglePin = async () => {
    const nextState = !isAlwaysOnTop;

    // Disabling Always-On-Top while Click-Through is active also safely turns off Click-Through
    if (!nextState && isClickThrough) {
      onToggleClickThrough();
    }

    const res = await setAlwaysOnTop(nextState);
    if (res !== null) {
      setIsAlwaysOnTop(res);
    }
  };

  const handleVerifyAndSaveAiKey = async () => {
    if (!apiKeyInput.trim()) {
      setAiKeyStatus({ type: "error", message: "Please enter an API key first." });
      return;
    }
    setAiKeyVerifying(true);
    setAiKeyStatus(null);
    try {
      const res: string = await invoke("verify_ai_key", { key: apiKeyInput.trim(), provider: providerInput });
      await setApiKey(apiKeyInput.trim(), providerInput, transcriptionKeyInput.trim() || undefined);
      localStorage.setItem("hackysack_api_key", encryptSecret(apiKeyInput.trim()));
      localStorage.setItem("hackysack_provider", providerInput);
      setAiKeyStatus({ type: "success", message: res });

      const needsSpeechKey = ["openrouter", "anthropic", "gemini"].includes(providerInput);
      const hasSpeechKey = Boolean(
        transcriptionKeyInput.trim() ||
        apiKeyInput.trim().startsWith("gsk_") ||
        (apiKeyInput.trim().startsWith("sk-") && !apiKeyInput.trim().startsWith("sk-or-") && !apiKeyInput.trim().startsWith("sk-ant-"))
      );

      if (needsSpeechKey && !hasSpeechKey) {
        setSpeechKeyStatus({
          type: "error",
          message: `⚠️ Speech Key Required: ${providerInput.toUpperCase()} powers AI answers, but requires a free Groq (gsk_...) or OpenAI key below for live speech listening.`
        });
      }
    } catch (err: any) {
      const msg = typeof err === "string" ? err : (err.message || "Key verification failed.");
      setAiKeyStatus({ type: "error", message: msg });
    } finally {
      setAiKeyVerifying(false);
    }
  };

  const handleVerifyAndSaveSpeechKey = async () => {
    if (!transcriptionKeyInput.trim()) {
      setSpeechKeyStatus({ type: "error", message: "Please enter a Voice API key first." });
      return;
    }
    setSpeechKeyVerifying(true);
    setSpeechKeyStatus(null);
    try {
      const res: string = await invoke("verify_speech_key", { key: transcriptionKeyInput.trim() });
      localStorage.setItem("hackysack_transcription_key", encryptSecret(transcriptionKeyInput.trim()));
      await setApiKey(apiKeyInput.trim(), providerInput, transcriptionKeyInput.trim());
      setSpeechKeyStatus({ type: "success", message: res });
    } catch (err: any) {
      const msg = typeof err === "string" ? err : (err.message || "Voice key verification failed.");
      setSpeechKeyStatus({ type: "error", message: msg });
    } finally {
      setSpeechKeyVerifying(false);
    }
  };



  const handleFileUpload = (
    docType: string,
    setter: (v: string) => void,
    storageKey: string,
    fileNameSetter: (n: string | null) => void,
    fileNameStorageKey: string,
    filePathSetter: (p: string | null) => void,
    filePathStorageKey: string,
  ) => async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    e.target.value = "";

    try {
      const arrayBuffer = await file.arrayBuffer();
      const bytes = Array.from(new Uint8Array(arrayBuffer));

      // Save file copy locally for opening natively later
      const savedPath = await saveContextDocument(docType, file.name, bytes);
      const filePath = savedPath || file.name;

      const ext = file.name.split('.').pop()?.toLowerCase() ?? "";
      let extracted = "";

      if (ext === "pdf" || ext === "docx") {
        extracted = (await parseDocument(bytes, file.name)) || "";
      } else {
        extracted = new TextDecoder().decode(new Uint8Array(arrayBuffer));
      }

      if (extracted) {
        setter(extracted);
        fileNameSetter(file.name);
        filePathSetter(filePath);
        localStorage.setItem(storageKey, extracted);
        localStorage.setItem(fileNameStorageKey, file.name);
        localStorage.setItem(filePathStorageKey, filePath);
      } else {
        alert(`Could not extract text from "${file.name}".`);
      }
    } catch (err) {
      console.error("Document parse error:", err);
      alert(`Failed to parse "${file.name}": ${err}`);
    }
  };

  // Clear a file-mode field back to manual text mode
  const clearField = (
    setter: (v: string) => void,
    storageKey: string,
    fileNameSetter: (n: string | null) => void,
    fileNameStorageKey: string,
    filePathSetter: (p: string | null) => void,
    filePathStorageKey: string,
  ) => {
    setter("");
    fileNameSetter(null);
    filePathSetter(null);
    localStorage.removeItem(storageKey);
    localStorage.removeItem(fileNameStorageKey);
    localStorage.removeItem(filePathStorageKey);
  };

  // Open a file using Windows default application
  const openFile = async (filePath: string | null) => {
    if (!filePath) return;
    try {
      await openFilePath(filePath);
    } catch (err) {
      console.warn("Could not open file:", err);
    }
  };

  const handlePing = async () => {
    const result = await ping("Hello from the frontend!");
    setPingResult(result ?? "No response");
    onPingTest();
    setTimeout(() => setPingResult(null), 4000);
  };

  return (
    <>
      {/* Toolbar Bar */}
      <div className={styles.toolbar} data-tauri-drag-region>
        <div className={styles.brand} data-tauri-drag-region>
          <img src={logoUrl} alt="HackySack Logo" style={{ width: 24, height: 24, objectFit: "contain", marginRight: 8, pointerEvents: "none" }} />
          <span className={styles.brandName} data-tauri-drag-region>Hacky<span className="gradient-text" data-tauri-drag-region>Sack</span></span>
          {hasAvailableUpdate && (
            <button
              className="btn btn-primary animate-pulse"
              style={{ fontSize: "10px", padding: "2px 7px", background: "linear-gradient(135deg, #6366f1, #8b5cf6)", color: "#ffffff", border: "none", gap: 3, marginLeft: 8 }}
              onClick={() => setShowSettings(true)}
              title={`HackySack v${hasAvailableUpdate} is available! Click to open Settings and update.`}
            >
              <RefreshCw size={10} /> v{hasAvailableUpdate} Update
            </button>
          )}
        </div>

        <div className={styles.center}>
          {pingResult ? (
            <div className={`${styles.pingResult} animate-fadeIn`}>
              {pingResult}
            </div>
          ) : null}
        </div>

        <div className={styles.actions}>
          {/* Stealth Mode Screen Protection Toggle */}
          {/* Stealth Mode Screen Protection Toggle */}
          <button
            id="btn-stealth-protection"
            className={`btn ${isProtected ? "btn-primary" : "btn-ghost"}`}
            onClick={handleToggleStealth}
            style={{ fontSize: "11px", gap: "4px", padding: "4px 8px" }}
            title={isProtected ? "Screen Capture Protection: ON (App hidden from recording/screenshots)" : "Screen Capture Protection: OFF"}
          >
            {isProtected ? <ShieldCheck size={13} style={{ color: "#10b981" }} /> : <ShieldOff size={13} />}
            <span className={styles.btnText}>{isProtected ? "Stealth" : "Stealth: Off"}</span>
          </button>

          {/* Always-on-top Pin Toggle */}
          <button
            id="btn-pin-on-top"
            className={`btn ${isAlwaysOnTop ? "btn-primary" : "btn-ghost"}`}
            onClick={handleTogglePin}
            style={{ padding: "4px 7px" }}
            title={isAlwaysOnTop ? "Pinned On Top" : "Unpinned"}
          >
            {isAlwaysOnTop ? <Pin size={13} style={{ color: "#38bdf8" }} /> : <PinOff size={13} />}
          </button>

          {/* Mouse Click-Through Pass Toggle */}
          <button
            id="btn-click-through"
            className={`btn ${isClickThrough ? "btn-primary" : "btn-ghost"}`}
            onClick={onToggleClickThrough}
            style={{ padding: "4px 7px" }}
            title={isClickThrough ? "Click-Through Active (Ctrl+Alt+C)" : "Click-Through Mode"}
          >
            {isClickThrough ? <MousePointer size={13} style={{ color: "#ef4444" }} /> : <MousePointer size={13} />}
          </button>

          {/* Window Opacity Slider */}
          <div
            style={{ display: "flex", alignItems: "center", gap: "3px", padding: "0 2px" }}
            className={`${styles.noDrag} interactive-slider-wrapper`}
            title="Transparency"
            data-tauri-drag-region="false"
          >
            <Sun size={12} style={{ color: "var(--accent-start)", opacity: 0.8 }} />
            <input
              id="toolbar-opacity-slider"
              type="range"
              min="0.05"
              max="1.0"
              step="0.05"
              value={appOpacity}
              onChange={onOpacityChange}
              className={styles.noDrag}
              style={{ width: "42px", height: "4px", cursor: "pointer", accentColor: "var(--accent-start)" }}
              data-tauri-drag-region="false"
            />
          </div>

          {/* AI Context Button */}
          <button
            ref={contextBtnRef}
            id="btn-ai-context"
            className={`btn ${showContext ? "btn-primary" : "btn-ghost"}`}
            onClick={() => { setShowContext(v => !v); if (showSettings) setShowSettings(false); if (showHotkeys) setShowHotkeys(false); }}
            title="Resume & Notes"
            style={{ fontSize: "11px", gap: "4px", padding: "4px 8px" }}
          >
            <Brain size={13} />
            <span className={styles.btnText}>Context</span> {(resumeText || jobDescText || extraContext) ? <span style={{ width: 6, height: 6, borderRadius: '50%', background: '#10b981', display: 'inline-block', marginLeft: 2 }} /> : null}
          </button>

          {/* Cloud Auth / Subscription Mode Toggle */}
          <button
            id="btn-cloud-plan"
            className={`btn ${isCloudMode ? "btn-primary" : "btn-ghost"}`}
            onClick={e => {
              e.stopPropagation();
              setShowCloudModal(true);
            }}
            title="Cloud Account"
            style={{ fontSize: "11px", gap: "4px", padding: "4px 7px" }}
          >
            <Cloud size={13} style={{ color: isCloudMode ? "#a855f7" : "inherit" }} />
            <span className={styles.btnText}>{isCloudMode ? "Cloud" : "BYOK"}</span>
          </button>

          {!isCloudMode && (
            <button
              id="btn-kofi-donate"
              className="btn"
              onClick={() => setShowDonateModal(true)}
              title="Support HackySack development on Ko-fi"
              style={{
                fontSize: "11px",
                fontWeight: 600,
                gap: "4px",
                padding: "4px 8px",
                background: "linear-gradient(135deg, rgba(245, 158, 11, 0.2), rgba(217, 119, 6, 0.25))",
                border: "1px solid rgba(245, 158, 11, 0.4)",
                color: "#f59e0b",
                borderRadius: "var(--radius-md)",
                cursor: "pointer",
                whiteSpace: "nowrap",
              }}
            >
              ☕ Buy me a coffee
            </button>
          )}

          <button
            id="btn-hotkeys"
            className="btn btn-ghost"
            onClick={() => { setShowHotkeys(v => !v); if (showContext) setShowContext(false); }}
            title="Shortcuts"
            style={{ padding: "4px 6px" }}
          >
            <HelpCircle size={14} />
          </button>

          <button
            ref={settingsBtnRef}
            id="btn-settings"
            className="btn btn-ghost"
            onClick={() => { setShowSettings(v => !v); if (showContext) setShowContext(false); }}
            title="Settings"
            style={{ padding: "4px 6px" }}
          >
            <Settings size={14} />
          </button>

          {/* Window Controls (Minimize, Maximize, Close) */}
          <div style={{ display: "flex", alignItems: "center", gap: "2px", marginLeft: "4px", borderLeft: "1px solid rgba(255,255,255,0.12)", paddingLeft: "6px" }}>
            <button
              id="btn-win-minimize"
              className="btn btn-ghost"
              style={{ padding: "4px 7px" }}
              onClick={() => getCurrentWindow().minimize()}
              title="Minimize Window"
            >
              <Minus size={13} />
            </button>
            <button
              id="btn-win-maximize"
              className="btn btn-ghost"
              style={{ padding: "4px 7px" }}
              onClick={async () => {
                try {
                  const win = getCurrentWindow();
                  if (await win.isMaximized()) {
                    await win.unmaximize();
                  } else {
                    await win.maximize();
                  }
                } catch (e) {
                  console.error("Maximize error:", e);
                }
              }}
              title="Maximize Window"
            >
              <Square size={12} />
            </button>
            <button
              id="btn-win-close"
              className="btn btn-ghost"
              style={{ padding: "4px 7px", color: "#ef4444" }}
              onClick={() => getCurrentWindow().close()}
              title="Close HackySack"
            >
              <X size={13} />
            </button>
          </div>
        </div>
      </div>

      {/* AI Context Panel */}
      {showContext && (
        <div ref={contextPanelRef} className={`${styles.settingsPanel} animate-fadeIn`} style={{ width: 340 }}>
          <div className={styles.settingsHeader}>
            <span><Brain size={15} style={{ display: 'inline', marginRight: 6 }} />Interview Context</span>
            <button className={styles.closeBtn} onClick={() => setShowContext(false)}><X size={14} /></button>
          </div>
          <div className={styles.settingsBody}>
            <p className={styles.keyNote} style={{ marginBottom: 10, fontSize: "12px" }}>
              Provide your resume, job description, and any additional notes so the AI can give personalized answers.
            </p>

            {/* Resume */}
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", cursor: "pointer" }} onClick={() => setExpandResume(v => !v)}>
              <label className={styles.label} style={{ margin: 0, cursor: "pointer", fontSize: "12px" }}><BookOpen size={13} style={{ display: "inline", marginRight: 5 }} />Resume {resumeText ? "✓" : ""}</label>
              <span style={{ fontSize: "12px", color: "var(--text-muted)" }}>{expandResume ? "▲" : "▼"}</span>
            </div>
            {expandResume && (
              <>
                {resumeFileName ? (
                  <div style={{ marginTop: 6, display: 'flex', alignItems: 'center', gap: 6, padding: '6px 10px', borderRadius: 6, background: 'rgba(16,185,129,0.08)', border: '1px solid rgba(16,185,129,0.25)' }}>
                    <button
                      onClick={() => openFile(resumeFilePath)}
                      title={resumeFilePath ? `Click to open in Windows: ${resumeFilePath}` : `Click to open: ${resumeFileName}`}
                      style={{ display: 'flex', alignItems: 'center', gap: 6, flex: 1, overflow: 'hidden', background: 'none', border: 'none', cursor: 'pointer', textAlign: 'left', padding: 0, color: '#10b981' }}
                    >
                      <FileText size={14} style={{ flexShrink: 0 }} />
                      <span style={{ fontSize: '12px', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', textDecoration: 'underline dotted' }}>
                        {resumeFileName}
                      </span>
                      <ExternalLink size={12} style={{ flexShrink: 0, opacity: 0.8 }} />
                    </button>
                    <button
                      className="btn btn-ghost"
                      style={{ fontSize: '11px', padding: '2px 7px', color: '#ef4444', border: '1px solid rgba(239,68,68,0.3)', borderRadius: 4, flexShrink: 0 }}
                      onClick={(e) => { e.stopPropagation(); clearField(setResumeText, "hackysack_resume", setResumeFileName, "hackysack_resume_filename", setResumeFilePath, "hackysack_resume_filepath"); }}
                      title="Remove file and clear resume"
                    >✕</button>
                  </div>
                ) : (
                  <textarea className="input" rows={4} placeholder="Paste your resume text here…" value={resumeText} onChange={e => { setResumeText(e.target.value); localStorage.setItem("hackysack_resume", e.target.value); }} style={{ marginTop: 6, fontSize: "12px", resize: "vertical" }} />
                )}
                {!resumeFileName && (
                  <label className="btn btn-ghost" style={{ marginTop: 4, fontSize: "12px", cursor: "pointer", display: "inline-flex", alignItems: "center", gap: 5 }}>
                    <FileText size={13} /> Upload file (.txt, .pdf, .docx)
                    <input type="file" accept=".txt,.md,.pdf,.docx" style={{ display: "none" }} onChange={handleFileUpload("resume", setResumeText, "hackysack_resume", setResumeFileName, "hackysack_resume_filename", setResumeFilePath, "hackysack_resume_filepath")} />
                  </label>
                )}
              </>
            )}

            {/* Job Description */}
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", cursor: "pointer", marginTop: 8 }} onClick={() => setExpandJD(v => !v)}>
              <label className={styles.label} style={{ margin: 0, cursor: "pointer", fontSize: "12px" }}><Briefcase size={13} style={{ display: "inline", marginRight: 5 }} />Job Description {jobDescText ? "✓" : ""}</label>
              <span style={{ fontSize: "12px", color: "var(--text-muted)" }}>{expandJD ? "▲" : "▼"}</span>
            </div>
            {expandJD && (
              <>
                {jobDescFileName ? (
                  <div style={{ marginTop: 6, display: 'flex', alignItems: 'center', gap: 6, padding: '6px 10px', borderRadius: 6, background: 'rgba(59,130,246,0.08)', border: '1px solid rgba(59,130,246,0.25)' }}>
                    <button
                      onClick={() => openFile(jobDescFilePath)}
                      title={jobDescFilePath ? `Click to open in Windows: ${jobDescFilePath}` : `Click to open: ${jobDescFileName}`}
                      style={{ display: 'flex', alignItems: 'center', gap: 6, flex: 1, overflow: 'hidden', background: 'none', border: 'none', cursor: 'pointer', textAlign: 'left', padding: 0, color: '#3b82f6' }}
                    >
                      <FileText size={14} style={{ flexShrink: 0 }} />
                      <span style={{ fontSize: '12px', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', textDecoration: 'underline dotted' }}>
                        {jobDescFileName}
                      </span>
                      <ExternalLink size={12} style={{ flexShrink: 0, opacity: 0.8 }} />
                    </button>
                    <button
                      className="btn btn-ghost"
                      style={{ fontSize: '11px', padding: '2px 7px', color: '#ef4444', border: '1px solid rgba(239,68,68,0.3)', borderRadius: 4, flexShrink: 0 }}
                      onClick={(e) => { e.stopPropagation(); clearField(setJobDescText, "hackysack_job_desc", setJobDescFileName, "hackysack_job_desc_filename", setJobDescFilePath, "hackysack_job_desc_filepath"); }}
                      title="Remove file and clear job description"
                    >✕</button>
                  </div>
                ) : (
                  <textarea className="input" rows={4} placeholder="Paste the job description here…" value={jobDescText} onChange={e => { setJobDescText(e.target.value); localStorage.setItem("hackysack_job_desc", e.target.value); }} style={{ marginTop: 6, fontSize: "12px", resize: "vertical" }} />
                )}
                {!jobDescFileName && (
                  <label className="btn btn-ghost" style={{ marginTop: 4, fontSize: "12px", cursor: "pointer", display: "inline-flex", alignItems: "center", gap: 5 }}>
                    <FileText size={13} /> Upload file (.txt, .pdf, .docx)
                    <input type="file" accept=".txt,.md,.pdf,.docx" style={{ display: "none" }} onChange={handleFileUpload("jobdesc", setJobDescText, "hackysack_job_desc", setJobDescFileName, "hackysack_job_desc_filename", setJobDescFilePath, "hackysack_job_desc_filepath")} />
                  </label>
                )}
              </>
            )}

            {/* Extra Context */}
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", cursor: "pointer", marginTop: 8 }} onClick={() => setExpandExtra(v => !v)}>
              <label className={styles.label} style={{ margin: 0, cursor: "pointer", fontSize: "12px" }}>📎 Additional Notes {extraContext ? "✓" : ""}</label>
              <span style={{ fontSize: "12px", color: "var(--text-muted)" }}>{expandExtra ? "▲" : "▼"}</span>
            </div>
            {expandExtra && (
              <>
                {extraFileName ? (
                  <div style={{ marginTop: 6, display: 'flex', alignItems: 'center', gap: 6, padding: '6px 10px', borderRadius: 6, background: 'rgba(139,92,246,0.08)', border: '1px solid rgba(139,92,246,0.25)' }}>
                    <button
                      onClick={() => openFile(extraFilePath)}
                      title={extraFilePath ? `Click to open in Windows: ${extraFilePath}` : `Click to open: ${extraFileName}`}
                      style={{ display: 'flex', alignItems: 'center', gap: 6, flex: 1, overflow: 'hidden', background: 'none', border: 'none', cursor: 'pointer', textAlign: 'left', padding: 0, color: '#8b5cf6' }}
                    >
                      <FileText size={14} style={{ flexShrink: 0 }} />
                      <span style={{ fontSize: '12px', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', textDecoration: 'underline dotted' }}>
                        {extraFileName}
                      </span>
                      <ExternalLink size={12} style={{ flexShrink: 0, opacity: 0.8 }} />
                    </button>
                    <button
                      className="btn btn-ghost"
                      style={{ fontSize: '11px', padding: '2px 7px', color: '#ef4444', border: '1px solid rgba(239,68,68,0.3)', borderRadius: 4, flexShrink: 0 }}
                      onClick={(e) => { e.stopPropagation(); clearField(setExtraContext, "hackysack_extra_context", setExtraFileName, "hackysack_extra_filename", setExtraFilePath, "hackysack_extra_filepath"); }}
                      title="Remove file and clear additional notes"
                    >✕</button>
                  </div>
                ) : (
                  <textarea className="input" rows={3} placeholder="Company info, tech stack, anything else…" value={extraContext} onChange={e => { setExtraContext(e.target.value); localStorage.setItem("hackysack_extra_context", e.target.value); }} style={{ marginTop: 6, fontSize: "12px", resize: "vertical" }} />
                )}
                {!extraFileName && (
                  <label className="btn btn-ghost" style={{ marginTop: 4, fontSize: "12px", cursor: "pointer", display: "inline-flex", alignItems: "center", gap: 5 }}>
                    <FileText size={13} /> Upload file (.txt, .pdf, .docx)
                    <input type="file" accept=".txt,.md,.pdf,.docx" style={{ display: "none" }} onChange={handleFileUpload("extra", setExtraContext, "hackysack_extra_context", setExtraFileName, "hackysack_extra_filename", setExtraFilePath, "hackysack_extra_filepath")} />
                  </label>
                )}
              </>
            )}
          </div>
        </div>
      )}

      {/* Hotkey Cheat Sheet Overlay */}
      {showHotkeys && (

        <div className={`${styles.settingsPanel} animate-fadeIn`} style={{ width: 260 }}>
          <div className={styles.settingsHeader}>
            <span>⌨️ Keyboard Shortcuts</span>
            <button className={styles.closeBtn} onClick={() => setShowHotkeys(false)}><X size={14} /></button>
          </div>
          <div className={styles.settingsBody}>
            {([
              ["Ctrl+Shift+H", "Show / Focus HackySack Window"],
              ["Ctrl+Shift+S", "Instant Screenshot at Cursor (Global)"],
              ["F8",          "Clear Context Buffer"],
              ["F9",          "Record / Stop Audio"],
              ["F10",         "Screenshot Screen"],
              ["F12",         "Ask AI (Context & History)"],
              ["Ctrl+Alt+C",  "Toggle Click-Through Pass"],
            ] as [string, string][]).map(([key, desc]) => (
              <div key={key} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "5px 0", borderBottom: "1px solid var(--border)" }}>
                <span style={{ fontSize: "11px", color: "var(--text-muted)" }}>{desc}</span>
                <kbd style={{ background: "var(--bg-elevated)", border: "1px solid var(--border)", borderRadius: 4, padding: "2px 6px", fontSize: "10px", fontFamily: "monospace", color: "var(--text-primary)" }}>{key}</kbd>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Settings Dropdown */}
      {showSettings && (
        <div ref={settingsPanelRef} className={`${styles.settingsPanel} animate-fadeIn`}>
          <div className={styles.settingsHeader}>
            <span>Settings</span>
            <button
              className={styles.closeBtn}
              onClick={() => setShowSettings(false)}
            >
              <X size={14} />
            </button>
          </div>

          <div className={styles.settingsBody}>
            {/* Category 0: App Version & Auto-Updates */}
            <div style={{ padding: "8px 10px", borderRadius: 6, background: "rgba(255,255,255,0.03)", border: "1px solid var(--border)", marginBottom: 8 }}>
              <div style={{ fontSize: "12px", fontWeight: 600, color: "var(--text-primary)", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                <div style={{ display: "flex", alignItems: "center", gap: "5px" }}>
                  <RefreshCw size={13} style={{ color: "var(--accent-start)" }} />
                  <span>HackySack v1.0.0</span>
                </div>
                <button
                  className="btn btn-ghost"
                  style={{ fontSize: "11px", padding: "2px 6px", color: "var(--accent-start)", gap: 3 }}
                  onClick={async () => {
                    setUpdateChecking(true);
                    setUpdateStatus(null);
                    try {
                      let update: any = null;
                      try {
                        update = await check();
                      } catch (tErr) {
                        console.log("Tauri native updater check note:", tErr);
                      }

                      if (update?.available) {
                        setUpdateStatus({
                          type: "available",
                          version: update.version,
                          message: `v${update.version} is available!`
                        });
                      } else {
                        // Fallback check against GitHub releases API
                        try {
                          const res = await fetch("https://api.github.com/repos/hackysackapp/HackySack/releases/latest");
                          if (res.ok) {
                            const data = await res.json();
                            const latestTag = data.tag_name?.replace(/^v/, "");
                            if (latestTag && latestTag !== "1.0.0") {
                              setUpdateStatus({
                                type: "available",
                                version: latestTag,
                                message: `v${latestTag} is available on GitHub!`
                              });
                              return;
                            }
                          }
                        } catch {}
                        setUpdateStatus({
                          type: "latest",
                          message: "You are on the latest version (v1.0.0)."
                        });
                      }
                    } catch (err: any) {
                      setUpdateStatus({
                        type: "latest",
                        message: "You are running the latest version (v1.0.0)."
                      });
                    } finally {
                      setUpdateChecking(false);
                    }
                  }}
                  disabled={updateChecking}
                >
                  <RefreshCw size={10} className={updateChecking ? "animate-spin" : ""} />
                  {updateChecking ? "Checking..." : "Check Updates"}
                </button>
              </div>

              {updateStatus && (
                <div style={{
                  padding: "5px 8px",
                  borderRadius: 4,
                  marginTop: 6,
                  fontSize: "11px",
                  background: updateStatus.type === "latest" ? "rgba(16,185,129,0.12)" : updateStatus.type === "available" ? "rgba(99,102,241,0.15)" : "rgba(239,68,68,0.12)",
                  border: `1px solid ${updateStatus.type === "latest" ? "rgba(16,185,129,0.3)" : updateStatus.type === "available" ? "rgba(99,102,241,0.3)" : "rgba(239,68,68,0.3)"}`,
                  color: updateStatus.type === "latest" ? "#10b981" : updateStatus.type === "available" ? "#a5b4fc" : "#ef4444"
                }}>
                  <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                    <span>{updateStatus.type === "latest" ? "✓ " : updateStatus.type === "available" ? "🚀 " : "✕ "} {updateStatus.message}</span>
                    {updateStatus.type === "available" && (
                      <button
                        className="btn btn-primary"
                        style={{ fontSize: "10px", padding: "2px 8px", marginLeft: 6 }}
                        onClick={async () => {
                          try {
                            const update = await check();
                            if (!update?.available) return;
                            setUpdateStatus({ type: "downloading", message: "Downloading & installing..." });
                            let downloaded = 0;
                            let contentLength = 0;
                            await update.downloadAndInstall((event) => {
                              if (event.event === "Started") {
                                contentLength = event.data.contentLength || 0;
                              } else if (event.event === "Progress") {
                                downloaded += event.data.chunkLength;
                                if (contentLength > 0) {
                                  setDownloadProgress(Math.round((downloaded / contentLength) * 100));
                                }
                              } else if (event.event === "Finished") {
                                setUpdateStatus({ type: "downloading", message: "Restarting app..." });
                              }
                            });
                            await relaunch();
                          } catch (e: any) {
                            setUpdateStatus({ type: "error", message: `Update failed: ${e?.message || e}` });
                          }
                        }}
                      >
                        Update Now
                      </button>
                    )}
                  </div>
                  {updateStatus.type === "downloading" && downloadProgress !== null && (
                    <div style={{ marginTop: 4, fontSize: "10px", color: "var(--text-secondary)" }}>
                      Progress: {downloadProgress}%
                    </div>
                  )}
                </div>
              )}
            </div>


            {/* Category 2: Copilot Options */}
            <div style={{ padding: "8px 10px", borderRadius: 6, background: "rgba(255,255,255,0.03)", border: "1px solid var(--border)", marginBottom: 8 }}>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "8px", marginBottom: "8px" }}>
                {/* Auto Question Response */}
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", background: "rgba(255,255,255,0.02)", padding: "4px 8px", borderRadius: 4, border: "1px solid var(--border)" }}>
                  <span style={{ fontSize: "11.5px", color: "var(--text-primary)" }}>⚡ Auto-Ask AI</span>
                  <button
                    className={`btn ${autoQuestionResponse ? "btn-primary" : "btn-ghost"}`}
                    style={{ fontSize: "10.5px", padding: "2px 7px" }}
                    onClick={() => {
                      const next = !autoQuestionResponse;
                      setAutoQuestionResponse(next);
                      localStorage.setItem("hackysack_auto_question", String(next));
                      if (!next && typeof (window as any).__clearAutoResponse === "function") {
                        (window as any).__clearAutoResponse();
                      }
                    }}
                  >
                    {autoQuestionResponse ? "ON" : "OFF"}
                  </button>
                </div>

                {/* Ask Overview Prompt on Record Stop */}
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", background: "rgba(255,255,255,0.02)", padding: "4px 8px", borderRadius: 4, border: "1px solid var(--border)" }}>
                  <span style={{ fontSize: "11.5px", color: "var(--text-primary)" }} data-tooltip="Show prompt asking to view Overview when recording stops">📊 Ask Overview on Stop</span>
                  <button
                    className={`btn ${showOverviewPrompt ? "btn-primary" : "btn-ghost"}`}
                    style={{ fontSize: "10.5px", padding: "2px 7px" }}
                    onClick={handleToggleOverviewPrompt}
                  >
                    {showOverviewPrompt ? "ON" : "OFF"}
                  </button>
                </div>
              </div>

              {/* Online Assessment / Coding Mode */}
              <div style={{ background: "rgba(255,255,255,0.02)", padding: "6px 8px", borderRadius: 4, border: "1px solid var(--border)" }}>
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                  <div style={{ display: "flex", flexDirection: "column" }}>
                    <span style={{ fontSize: "11.5px", fontWeight: 600, color: "var(--text-primary)" }}>💻 Online Assessment / Coding Mode</span>
                    <span style={{ fontSize: "10px", color: "var(--text-muted)" }}>Tailors screenshots for LeetCode, Codility, HackerRank & CodeSignal</span>
                  </div>
                  <button
                    className={`btn ${codingOAMode ? "btn-primary" : "btn-ghost"}`}
                    style={{ fontSize: "10.5px", padding: "2px 8px" }}
                    onClick={() => {
                      const next = !codingOAMode;
                      setCodingOAMode(next);
                      localStorage.setItem("hackysack_coding_oa_mode", String(next));
                    }}
                  >
                    {codingOAMode ? "ON" : "OFF"}
                  </button>
                </div>

                {codingOAMode && (
                  <div style={{ marginTop: "6px", display: "flex", alignItems: "center", justifyContent: "space-between", paddingTop: "6px", borderTop: "1px solid var(--border)" }}>
                    <span style={{ fontSize: "11px", color: "var(--text-secondary)" }}>Preferred Language:</span>
                    <select
                      className="input"
                      style={{ fontSize: "11px", padding: "3px 6px", width: "auto", minWidth: "135px", background: "var(--bg-elevated)", color: "var(--text-primary)", border: "1px solid var(--border)", borderRadius: "4px" }}
                      value={codingOALang}
                      onChange={(e) => {
                        const val = e.target.value;
                        setCodingOALang(val);
                        localStorage.setItem("hackysack_coding_oa_lang", val);
                      }}
                    >
                      <option value="Python 3">Python 3</option>
                      <option value="C++ (C++20)">C++ (C++20)</option>
                      <option value="Java (Java 17/21)">Java (Java 17/21)</option>
                      <option value="TypeScript">TypeScript</option>
                      <option value="JavaScript">JavaScript</option>
                      <option value="C# (.NET 8)">C# (.NET 8)</option>
                      <option value="Go (Golang)">Go (Golang)</option>
                      <option value="Rust">Rust</option>
                      <option value="SQL (PostgreSQL)">SQL (PostgreSQL)</option>
                      <option value="SQL (MySQL)">SQL (MySQL)</option>
                      <option value="SQL (Oracle / T-SQL)">SQL (Oracle / T-SQL)</option>
                      <option value="Kotlin">Kotlin</option>
                      <option value="Swift">Swift</option>
                      <option value="PHP">PHP</option>
                      <option value="Ruby">Ruby</option>
                      <option value="Scala">Scala</option>
                      <option value="R">R</option>
                      <option value="Bash / Shell">Bash / Shell</option>
                    </select>
                  </div>
                )}
              </div>
            </div>

            {/* Category 3: Audio Devices */}
            <div style={{ padding: "8px 10px", borderRadius: 6, background: "rgba(255,255,255,0.03)", border: "1px solid var(--border)", marginBottom: 8 }}>
              <div style={{ fontSize: "12px", fontWeight: 600, color: "var(--text-primary)", marginBottom: 6, display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                <div style={{ display: "flex", alignItems: "center", gap: "5px" }}>
                  <Mic size={13} /> <span>Audio Hardware Devices</span>
                </div>
                <button
                  className="btn btn-ghost"
                  style={{ fontSize: "11px", padding: "2px 6px", color: "var(--accent-start)", gap: 3 }}
                  onClick={() => {
                    try {
                      shellOpen("ms-settings:privacy-microphone");
                    } catch {
                      window.open("ms-settings:privacy-microphone");
                    }
                  }}
                  data-tooltip="Open Windows Microphone Privacy Settings"
                >
                  <ExternalLink size={10} /> Fix Windows Permission
                </button>
              </div>

              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "8px" }}>
                <select
                  className={styles.select}
                  value={selectedMicId}
                  onChange={e => {
                    const val = e.target.value;
                    setSelectedMicId(val);
                    localStorage.setItem("hackysack_mic_id", val);
                    if (typeof (window as any).__restartAudioStream === "function") {
                      (window as any).__restartAudioStream(val, selectedSpeakerId);
                    }
                  }}
                  style={{ fontSize: "11.5px", padding: "4px 8px" }}
                >
                  <option value="">Default Mic</option>
                  {mics.map((m, i) => (
                    <option key={m.deviceId || i} value={m.deviceId}>
                      {m.label || `Mic ${i + 1}`}
                    </option>
                  ))}
                </select>

                <select
                  className={styles.select}
                  value={selectedSpeakerId}
                  onChange={e => {
                    const val = e.target.value;
                    setSelectedSpeakerId(val);
                    localStorage.setItem("hackysack_speaker_id", val);
                    if (typeof (window as any).__restartAudioStream === "function") {
                      (window as any).__restartAudioStream(selectedMicId, val);
                    }
                  }}
                  style={{ fontSize: "11.5px", padding: "4px 8px" }}
                  title="Select native speaker device for system audio loopback"
                >
                  <option value="">Default Speaker</option>
                  {speakers.map((s, i) => (
                    <option key={s.deviceId || i} value={s.deviceId}>
                      {s.label || `Speaker ${i + 1}`}
                    </option>
                  ))}
                </select>
              </div>
            </div>

            {/* Category 4: AI Provider & Keys */}
            <div style={{ padding: "8px 10px", borderRadius: 6, background: "rgba(255,255,255,0.03)", border: "1px solid var(--border)" }}>
              <div style={{ fontSize: "12px", fontWeight: 600, color: "var(--text-primary)", marginBottom: 6, display: "flex", alignItems: "center", gap: "5px" }}>
                <Key size={13} /> <span>1. AI Model & Answer Key</span>
              </div>

              <select
                id="provider-selector"
                className={styles.select}
                value={providerInput}
                onChange={e => setProviderInput(e.target.value)}
                style={{ marginBottom: 6, fontSize: "11.5px", padding: "4px 8px" }}
                title="Select your AI Provider (OpenRouter, Groq, OpenAI, Anthropic, Gemini)"
              >
                <option value="openrouter">OpenRouter (Access 100+ Models)</option>
                <option value="groq">Groq (100% Free Unlimited Text + Voice)</option>
                <option value="openai">OpenAI (GPT-4o & Whisper)</option>
                <option value="anthropic">Anthropic (Claude 3.5 Sonnet)</option>
                <option value="gemini">Google (Gemini 1.5 Flash)</option>
              </select>

              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 6 }}>
                <span style={{ fontSize: "11px", color: "var(--text-muted)" }}>Don't have a key?</span>
                <button
                  className="btn btn-ghost"
                  style={{ fontSize: "11px", padding: "2px 6px", color: "var(--accent-start)", gap: 4 }}
                  title={`Open official ${providerInput} website to get a key`}
                  onClick={() => {
                    const urls: Record<string, string> = {
                      openrouter: "https://openrouter.ai/keys",
                      groq: "https://console.groq.com/keys",
                      openai: "https://platform.openai.com/api-keys",
                      anthropic: "https://console.anthropic.com/settings/keys",
                      gemini: "https://aistudio.google.com/app/apikey",
                    };
                    const url = urls[providerInput] || urls.openrouter;
                    try { shellOpen(url); } catch { window.open(url, "_blank"); }
                  }}
                >
                  <ExternalLink size={10} /> Get {providerInput} Key
                </button>
              </div>

              <div style={{ display: "flex", gap: "6px", marginBottom: 4 }}>
                <input
                  id="api-key-input"
                  type="password"
                  className="input"
                  placeholder={`Paste ${providerInput} Key…`}
                  value={apiKeyInput}
                  onChange={e => { setApiKeyInput(e.target.value); setAiKeyStatus(null); }}
                  onKeyDown={e => { if (e.key === "Enter") handleVerifyAndSaveAiKey(); }}
                  style={{ flex: 1, fontSize: "11.5px", padding: "4px 8px" }}
                  title="Enter secret API key for your chosen provider"
                />
                <button
                  id="btn-save-key"
                  className="btn btn-primary"
                  onClick={handleVerifyAndSaveAiKey}
                  title="Verify key with AI provider and save to Windows Credential Manager"
                  disabled={!apiKeyInput.trim() || aiKeyVerifying}
                  style={{ fontSize: "11px", padding: "3px 10px", whiteSpace: "nowrap" }}
                >
                  {aiKeyVerifying ? "..." : "Save & Verify"}
                </button>
              </div>

              {aiKeyStatus && (
                <div style={{
                  padding: "4px 8px",
                  borderRadius: 4,
                  marginTop: 4,
                  fontSize: "11px",
                  background: aiKeyStatus.type === "success" ? "rgba(16,185,129,0.12)" : "rgba(239,68,68,0.12)",
                  border: `1px solid ${aiKeyStatus.type === "success" ? "rgba(16,185,129,0.3)" : "rgba(239,68,68,0.3)"}`,
                  color: aiKeyStatus.type === "success" ? "#10b981" : "#ef4444"
                }}>
                  {aiKeyStatus.type === "success" ? "✓ " : "✕ "} {aiKeyStatus.message}
                </div>
              )}

              {["openrouter", "anthropic", "gemini"].includes(providerInput) && (
                <div style={{ marginTop: 8, padding: "8px 10px", borderRadius: 4, background: "rgba(99,102,241,0.08)", border: "1px solid rgba(99,102,241,0.25)" }}>
                  <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 5 }}>
                    <span style={{ fontSize: "12px", fontWeight: 600, color: "var(--text-primary)" }}>🎙️ 2. Voice-to-Text Key</span>
                    <button
                      className="btn btn-ghost"
                      style={{ fontSize: "10px", padding: "2px 6px", color: "#10b981", gap: 3 }}
                      onClick={() => { try { shellOpen("https://console.groq.com/keys"); } catch { window.open("https://console.groq.com/keys", "_blank"); } }}
                    >
                      <ExternalLink size={10} /> Get Free Groq Key
                    </button>
                  </div>
                  <div style={{ display: "flex", gap: "6px" }}>
                    <input
                      type="password"
                      className="input"
                      placeholder="Groq (gsk_...) or OpenAI Key…"
                      value={transcriptionKeyInput}
                      onChange={e => { setTranscriptionKeyInput(e.target.value); setSpeechKeyStatus(null); }}
                      onKeyDown={e => { if (e.key === "Enter") handleVerifyAndSaveSpeechKey(); }}
                      style={{ fontSize: "11.5px", flex: 1, padding: "4px 8px" }}
                    />
                    <button
                      className="btn btn-primary"
                      onClick={handleVerifyAndSaveSpeechKey}
                      disabled={!transcriptionKeyInput.trim() || speechKeyVerifying}
                      style={{ fontSize: "11px", padding: "3px 10px", whiteSpace: "nowrap" }}
                    >
                      {speechKeyVerifying ? "..." : "Save & Verify"}
                    </button>
                  </div>

                  {speechKeyStatus && (
                    <div style={{
                      padding: "4px 8px",
                      borderRadius: 4,
                      marginTop: 4,
                      fontSize: "11px",
                      background: speechKeyStatus.type === "success" ? "rgba(16,185,129,0.12)" : "rgba(239,68,68,0.12)",
                      border: `1px solid ${speechKeyStatus.type === "success" ? "rgba(16,185,129,0.3)" : "rgba(239,68,68,0.3)"}`,
                      color: speechKeyStatus.type === "success" ? "#10b981" : "#ef4444"
                    }}>
                      {speechKeyStatus.type === "success" ? "✓ " : "✕ "} {speechKeyStatus.message}
                    </div>
                  )}
                </div>
              )}
            </div>

            <p className={styles.keyNote} style={{ marginTop: 6, padding: '6px 8px', borderRadius: 4, background: 'rgba(99,102,241,0.08)', border: '1px solid rgba(99,102,241,0.2)', color: 'var(--text-muted)', fontSize: '11px', margin: 0 }}>
              💡 Resume, Job Description, and Notes are in the <strong style={{ color: 'var(--text-primary)' }}>Context</strong> panel (Brain icon).
            </p>
            <div style={{ height: "24px", flexShrink: 0 }} />
          </div>
        </div>
      )}

      {(showCloudModal || forceOpenCloudModal) && createPortal(
        <CloudAuthModal
          initialTab={isCloudMode ? "cloud" : "byok"}
          onClose={() => {
            setShowCloudModal(false);
            if (onCloudModalClosed) onCloudModalClosed();
          }}
          onModeChanged={() => {
            invoke<any>("get_cloud_config").then((cfg) => {
              setIsCloudMode(Boolean(cfg && cfg.enabled));
            }).catch(() => setIsCloudMode(false));
          }}
          onOpenBYOKWizard={onOpenOnboarding}
        />,
        document.body
      )}

      {showDonateModal && createPortal(
        <DonateModal onClose={() => setShowDonateModal(false)} />,
        document.body
      )}
    </>
  );
}
