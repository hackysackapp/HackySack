import { useState, useCallback, useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow, LogicalSize } from "@tauri-apps/api/window";
import { Toolbar } from "./components/Toolbar";
import { ContextBuffer } from "./components/ContextBuffer";
import { AIResponse } from "./components/AIResponse";
import { RecordingsView } from "./components/RecordingsView";
import { OnboardingModal } from "./components/OnboardingModal";
import { CloudActivationModal } from "./components/CloudActivationModal";
import { CloudExpiredModal } from "./components/CloudExpiredModal";
import { OverviewPromptModal } from "./components/OverviewPromptModal";
import { useTauri, ContextItem } from "./hooks/useTauri";
import styles from "./App.module.css";

import { createPortal } from "react-dom";
import { Sparkles } from "lucide-react";
import { encryptSecret, decryptSecret } from "./utils/crypto";

export default function App() {
  const { setApiKey, setClickThrough, setAlwaysOnTop, setInteractiveRegions } = useTauri();
  const [contextItems, setContextItems] = useState<ContextItem[]>([]);
  const [activeView, setActiveView] = useState<"live" | "recordings">("live");
  const [pingCount, setPingCount] = useState(0);
  const [showCloudModal, setShowCloudModal] = useState(false);
  const [isClickThrough, setIsClickThrough] = useState(false);
  const [appOpacity, setAppOpacity] = useState(1.0);
  const [showOnboarding, setShowOnboarding] = useState(false);
  const [showActivationModal, setShowActivationModal] = useState(false);
  const [showCloudExpiredModal, setShowCloudExpiredModal] = useState(false);
  const [showOverviewPrompt, setShowOverviewPrompt] = useState<boolean>(() => {
    return localStorage.getItem("hackysack_show_overview") !== "false";
  });
  const [showOverviewPromptModal, setShowOverviewPromptModal] = useState(false);
  const flushLiveTranscriptRef = useRef<(() => ContextItem | null) | null>(null);

  const handleToggleOverviewPrompt = useCallback(() => {
    setShowOverviewPrompt(prev => {
      const next = !prev;
      localStorage.setItem("hackysack_show_overview", String(next));
      return next;
    });
  }, []);

  const handleRecordingStop = useCallback(() => {
    if (showOverviewPrompt) {
      setShowOverviewPromptModal(true);
    } else {
      setActiveView("recordings");
    }
  }, [showOverviewPrompt]);

  // Expand and focus window whenever a modal (Cloud Activation or Onboarding) is active
  useEffect(() => {
    if (showActivationModal || showOnboarding) {
      try {
        const appWin = getCurrentWindow();
        appWin.unminimize().catch(() => {});
        appWin.setSize(new LogicalSize(580, 680)).catch(() => {});
        appWin.center().catch(() => {});
        appWin.show().catch(() => {});
        appWin.setAlwaysOnTop(true).catch(() => {});
        appWin.setFocus().catch(() => {});
      } catch (e) {
        console.error("Window sizing error:", e);
      }
    }
  }, [showActivationModal, showOnboarding]);

  const triggerActivationSuccess = useCallback(async (token?: string) => {
    try {
      const cleanToken = token && token.trim() ? token.trim() : "hs_cloud_active";
      if (cleanToken.startsWith("hs_")) {
        localStorage.setItem("hackysack_cloud_jwt", encryptSecret(cleanToken));
      }
      localStorage.setItem("hackysack_cloud_enabled", "true");
      localStorage.setItem("hackysack_activation_success_token", cleanToken);

      setShowOnboarding(false);
      setShowActivationModal(true);

      // Close any open auth/settings modals
      if ((window as any).__closeCloudModal) {
        try { (window as any).__closeCloudModal(); } catch (_) {}
      }

      // Refresh cloud status across components
      if ((window as any).__refreshCloudStatus) {
        try { (window as any).__refreshCloudStatus(); } catch (_) {}
      }

      // Reset the backend just_activated flag
      invoke("acknowledge_activation").catch(() => {});

      // Bring window directly to front and size it for modal display
      try {
        const appWin = getCurrentWindow();
        await appWin.unminimize();
        await appWin.setSize(new LogicalSize(580, 680));
        await appWin.center();
        await appWin.show();
        await appWin.setAlwaysOnTop(true);
        await appWin.setFocus();
      } catch (winErr) {
        console.error("Failed to focus window on activation:", winErr);
      }
    } catch (e) {
      console.error("Error triggering activation success:", e);
    }
  }, []);

  // Check if initial onboarding is needed on startup (or if Cloud mode is active)
  useEffect(() => {
    try {
      const appWin = getCurrentWindow();
      appWin.unminimize().catch(() => {});
      appWin.show().catch(() => {});
      appWin.setAlwaysOnTop(true).catch(() => {});
      appWin.setFocus().catch(() => {});
    } catch (e) {
      console.error("Startup focus error:", e);
    }

    invoke<{ enabled: boolean; hasToken: boolean; jwt?: string; justActivated?: boolean }>("get_cloud_config")
      .then(res => {
        if (res && res.enabled && res.hasToken) {
          localStorage.setItem("hackysack_cloud_enabled", "true");
          setShowOnboarding(false);
          setAlwaysOnTop(true);
          const savedActToken = localStorage.getItem("hackysack_activation_success_token");
          if (savedActToken || res.justActivated) {
            triggerActivationSuccess(res.jwt || savedActToken || "hs_cloud_active");
          }

          // Verify if cloud subscription is still active in database
          setTimeout(() => {
            invoke("ask_ai", { prompt: "__status__", contextItems: [], model: "google/gemini-2.5-flash" })
              .catch(err => {
                console.warn("Cloud token startup check failed:", err);
                setShowCloudExpiredModal(true);
              });
          }, 300);
          return;
        }

        // Cloud mode is not active. Clear local cloud_enabled state and check if BYOK key exists.
        localStorage.setItem("hackysack_cloud_enabled", "false");
        const localEncKey = localStorage.getItem("hackysack_api_key");
        const savedProvider = localStorage.getItem("hackysack_provider") || "groq";

        if (localEncKey && localEncKey.trim()) {
          const rawKey = decryptSecret(localEncKey);
          if (rawKey && rawKey.trim()) {
            setApiKey(rawKey, savedProvider).catch(console.error);
            setShowOnboarding(false);
            setAlwaysOnTop(true);
            return;
          }
        }

        invoke<string | null>("get_secure_key", { keyName: "ai_api_key" })
          .then(decryptedKey => {
            if (!decryptedKey || !decryptedKey.trim()) {
              setShowOnboarding(true);
            } else {
              setApiKey(decryptedKey, savedProvider).catch(console.error);
              setShowOnboarding(false);
            }
            setAlwaysOnTop(true);
          })
          .catch(() => {
            setShowOnboarding(true);
            setAlwaysOnTop(true);
          });
      })
      .catch(() => {
        setShowOnboarding(true);
        setAlwaysOnTop(true);
      });
  }, [setAlwaysOnTop, setApiKey, triggerActivationSuccess]);

  const handleCloseOnboarding = useCallback(async () => {
    setShowOnboarding(false);
    await setAlwaysOnTop(true);
  }, [setAlwaysOnTop]);

  const handleOnboardingComplete = async (key: string, provider: string, transKey?: string) => {
    await setApiKey(key, provider, transKey);
    localStorage.setItem("hackysack_api_key", encryptSecret(key));
    localStorage.setItem("hackysack_provider", provider);
    if (transKey) {
      localStorage.setItem("hackysack_transcription_key", encryptSecret(transKey));
    } else {
      localStorage.removeItem("hackysack_transcription_key");
    }
    await handleCloseOnboarding();
  };

  // Listen for 1-Click Deep Link activation: hackysack://activate?token=hs_cloud_...
  useEffect(() => {
    const extractUrlsAndTokens = (input: any): string[] => {
      if (!input) return [];
      if (typeof input === "string") return [input];
      if (Array.isArray(input)) return input.flatMap(extractUrlsAndTokens);
      if (typeof input === "object") {
        const results: string[] = [];
        if (input.token) results.push(input.token);
        if (input.url) results.push(input.url);
        if (input.urls) results.push(...extractUrlsAndTokens(input.urls));
        if (input.payload) results.push(...extractUrlsAndTokens(input.payload));
        return results;
      }
      return [];
    };

    const parseTokenFromUrl = (rawUrl: string): string => {
      if (!rawUrl || typeof rawUrl !== "string") return "hs_cloud_active";
      if (rawUrl.startsWith("hs_")) return rawUrl.trim();
      const paramMatch = rawUrl.match(/(?:token|jwt|key|access_token)=([^&/#"'\s]+)/i);
      if (paramMatch && paramMatch[1]) {
        return decodeURIComponent(paramMatch[1]).trim().replace(/^["']|["']$/g, "").replace(/\/+$/, "");
      }
      const hsMatch = rawUrl.match(/(hs_[a-zA-Z0-9_\-\.]+)/);
      if (hsMatch && hsMatch[1]) {
        return hsMatch[1].trim().replace(/\/+$/, "");
      }
      return "hs_cloud_active";
    };

    const processDeepLink = async (payload: any) => {
      const items = extractUrlsAndTokens(payload);
      for (const item of items) {
        if (item && typeof item === "string") {
          try {
            const cleanToken = parseTokenFromUrl(item);
            await invoke("set_cloud_config", {
              enabled: true,
              jwt: cleanToken.startsWith("hs_") ? cleanToken : null,
              endpoint: "https://vzuutupafqjrmfuncgxl.supabase.co/functions/v1/ai-proxy",
            });
            await triggerActivationSuccess(cleanToken);
          } catch (e) {
            console.error("Failed to parse deep link activation:", e);
          }
        }
      }
    };

    const unlisteners: (() => void)[] = [];

    listen<any>("cloud-activated", (event) => processDeepLink(event.payload))
      .then(fn => unlisteners.push(fn))
      .catch(() => {});

    listen<any>("deep-link-received", (event) => processDeepLink(event.payload))
      .then(fn => unlisteners.push(fn))
      .catch(() => {});

    listen<any>("deep-link://new-url", (event) => processDeepLink(event.payload))
      .then(fn => unlisteners.push(fn))
      .catch(() => {});

    listen<any>("plugin:deep-link|onUrlOpen", (event) => processDeepLink(event.payload))
      .then(fn => unlisteners.push(fn))
      .catch(() => {});

    // Expose helper to trigger expired modal from any component
    (window as any).__triggerCloudExpiredModal = () => {
      setShowCloudExpiredModal(true);
    };

    return () => {
      unlisteners.forEach(fn => fn());
    };
  }, [triggerActivationSuccess]);

  // Load and apply saved opacity
  useEffect(() => {
    const savedOpacity = localStorage.getItem("hackysack_app_opacity");
    if (savedOpacity) {
      const val = parseFloat(savedOpacity);
      if (!isNaN(val)) {
        setAppOpacity(val);
        document.documentElement.style.setProperty("--app-opacity", val.toString());
      }
    }
  }, []);

  useEffect(() => {
    // Add CSS variable for opacity
    document.documentElement.style.setProperty("--app-opacity", appOpacity.toString());
  }, [appOpacity]);

  // Global Hotkeys (F8–F12)
  useEffect(() => {
    const handleGlobalHotkeys = (e: KeyboardEvent) => {
      // F8: Clear Context Buffer
      if (e.code === "F8") {
        e.preventDefault();
        document.getElementById("btn-clear-context")?.click();
      }
      // F9: Record / Stop
      if (e.code === "F9") {
        e.preventDefault();
        document.getElementById("btn-record")?.click();
      }
      // F10: Screenshot
      if (e.code === "F10") {
        e.preventDefault();
        document.getElementById("btn-screenshot")?.click();
      }
      // F11 or F12: Ask AI (Includes prior Q&A history automatically)
      if (e.code === "F12" || e.code === "F11") {
        e.preventDefault();
        document.getElementById("btn-ask-ai")?.click();
      }
    };

    window.addEventListener("keydown", handleGlobalHotkeys);
    return () => window.removeEventListener("keydown", handleGlobalHotkeys);
  }, []);

  const handleOpacityChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const val = parseFloat(e.target.value);
    setAppOpacity(val);
    document.documentElement.style.setProperty("--app-opacity", val.toString());
    localStorage.setItem("hackysack_app_opacity", val.toString());
  };

  const handlePingTest = useCallback(() => {
    setPingCount(n => n + 1);
  }, []);

  const handleToggleClickThrough = useCallback(async () => {
    const nextState = !isClickThrough;
    setIsClickThrough(nextState);
    if (nextState) {
      document.documentElement.setAttribute("data-click-through", "true");
      await setAlwaysOnTop(true);
      await setClickThrough(true);
    } else {
      document.documentElement.removeAttribute("data-click-through");
      await setClickThrough(false);
    }
  }, [isClickThrough, setAlwaysOnTop, setClickThrough]);

  // Track dynamic interactive regions to send to Rust for accurate hit-testing
  useEffect(() => {
    if (!isClickThrough) return;

    let timeoutId: number;
    let lastRegionsStr = "";

    const updateRegions = () => {
      // Target all interactive controls (buttons, inputs, textareas, dropdowns, window controls)
      // Excludes empty panel space so clicks pass through to desktop behind!
      const regions: { x: number; y: number; width: number; height: number }[] = [];

      // 1. Fully interactive elements
      const elements = document.querySelectorAll(
        '.btn, button, input, textarea, select, #btn-win-minimize, #btn-win-maximize, #btn-win-close, [class*="topbar"], [class*="historyCard"], [class*="cornerGrip"], [class*="conciseOverviewCard"], [class*="detailModal"], [class*="backBtn"], [class*="modal"], [class*="Modal"], [class*="settingsPanel"], [class*="settingsBody"], [style*="fixed"], div[style*="position: fixed"]'
      );
      elements.forEach(el => {
        const rect = el.getBoundingClientRect();
        if (rect.width > 0 && rect.height > 0) {
          regions.push({
            x: Math.max(0, Math.floor(rect.x - 4)),
            y: Math.max(0, Math.floor(rect.y - 4)),
            width: Math.ceil(rect.width + 8),
            height: Math.ceil(rect.height + 8)
          });
        }
      });

      // 2. Scrollbars only for transcript and main content areas
      const scrollContainers = document.querySelectorAll(
        '[class*="contextStream"], [class*="content"], [class*="sidebar"], [class*="container"], [class*="detailBody"], [class*="continuousTranscriptBox"]'
      );
      scrollContainers.forEach(el => {
        const rect = el.getBoundingClientRect();
        if (rect.width > 0 && rect.height > 0) {
          // Only the rightmost 16px (scrollbar area) captures clicks
          regions.push({
            x: Math.max(0, Math.floor(rect.right - 16)),
            y: Math.max(0, Math.floor(rect.y)),
            width: 16,
            height: Math.ceil(rect.height)
          });
        }
      });

      // Only send IPC to Rust if the regions have actually changed
      const currentRegionsStr = JSON.stringify(regions);
      if (currentRegionsStr !== lastRegionsStr) {
        setInteractiveRegions(regions);
        lastRegionsStr = currentRegionsStr;
      }
    };

    updateRegions();

    // Use observers instead of aggressive polling to be memory-friendly
    const mutationObserver = new MutationObserver(updateRegions);
    mutationObserver.observe(document.body, { 
      childList: true, 
      subtree: true, 
      attributes: true, 
      characterData: true 
    });

    window.addEventListener('resize', updateRegions, { passive: true });
    // Capture phase scroll listener catches all scrolling inside the app
    window.addEventListener('scroll', updateRegions, { capture: true, passive: true });

    // Fallback slow poll for any layout animations missed by observers
    timeoutId = window.setInterval(updateRegions, 1500);

    return () => {
      mutationObserver.disconnect();
      window.removeEventListener('resize', updateRegions);
      window.removeEventListener('scroll', updateRegions, { capture: true });
      clearInterval(timeoutId);
    };
  }, [isClickThrough, setInteractiveRegions]);



  return (
    <div className={styles.root}>
      {/* Visual Bottom Corner Drag Handles */}
      <div
        className={`${styles.cornerGrip} ${styles.cornerBottomLeft}`}
        title="Drag corner to resize"
      >
        <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
          <path d="M2 2L8 8M2 5L5 8M2 8L2 8.01" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
        </svg>
      </div>
      <div
        className={`${styles.cornerGrip} ${styles.cornerBottomRight}`}
        title="Drag corner to resize"
      >
        <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
          <path d="M8 2L2 8M8 5L5 8M2 8L2 8.01" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
        </svg>
      </div>

      {/* Top Bar */}
      <div className={styles.topbar}>
        <Toolbar
          onPingTest={handlePingTest}
          isClickThrough={isClickThrough}
          onToggleClickThrough={handleToggleClickThrough}
          activeView={activeView}
          onToggleView={() => setActiveView(v => v === "live" ? "recordings" : "live")}
          appOpacity={appOpacity}
          onOpacityChange={handleOpacityChange}
          showOverviewPrompt={showOverviewPrompt}
          onToggleOverviewPrompt={handleToggleOverviewPrompt}
          onOpenOnboarding={() => setShowOnboarding(true)}
          forceOpenCloudModal={showCloudModal}
          onCloudModalClosed={() => setShowCloudModal(false)}
        />
        <div id="top-bar-portal" style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '8px 14px 4px 14px' }} />
      </div>

      {/* Main Layout: Live Copilot View VS Session Overview */}
      {activeView === "recordings" ? (
        <main className={styles.main} style={{ overflow: "hidden" }}>
          <RecordingsView
            contextItems={contextItems}
            onBackToLive={() => setActiveView("live")}
            onClearHistory={() => setContextItems([])}
          />
        </main>
      ) : (
        <div className={styles.main}>
          {/* Left: Context Buffer */}
          <aside className={`${styles.sidebar} glass-panel`}>
            <ContextBuffer
              items={contextItems}
              onItemsChange={setContextItems}
              registerFlushCallback={(cb) => { flushLiveTranscriptRef.current = cb; }}
              onRecordingStart={() => setActiveView("live")}
              onRecordingStop={handleRecordingStop}
            />
          </aside>

          {/* Divider */}
          <div className={styles.divider} />

          {/* Right: AI Response Stream */}
          <main className={styles.content}>
            <AIResponse 
              contextItems={contextItems} 
              onBeforeAsk={() => flushLiveTranscriptRef.current?.() || null}
            />
          </main>
        </div>
      )}

      {/* Bottom Dock Portal */}
      <div id="bottom-dock-portal" className={styles.bottomDock} />

      {/* Onboarding Wizard */}
      {showOnboarding && (
        <OnboardingModal
          onClose={handleCloseOnboarding}
          onComplete={handleOnboardingComplete}
        />
      )}

      {/* Cloud Activation Success Modal */}
      {showActivationModal && (
        <CloudActivationModal
          onClose={() => {
            setShowActivationModal(false);
            localStorage.removeItem("hackysack_activation_success_token");
          }}
        />
      )}

      {/* Cloud Subscription Expired / Inactive Modal */}
      {showCloudExpiredModal && (
        <CloudExpiredModal
          onClose={() => setShowCloudExpiredModal(false)}
          onSwitchToBYOK={async () => {
            setShowCloudExpiredModal(false);
            try {
              await invoke("set_cloud_config", { enabled: false, jwt: null, endpoint: null });
            } catch (e) {}
            localStorage.setItem("hackysack_cloud_enabled", "false");
            setShowOnboarding(true);
          }}
        />
      )}

      {/* Overview Prompt Modal */}
      <OverviewPromptModal
        isOpen={showOverviewPromptModal}
        onConfirm={() => {
          setShowOverviewPromptModal(false);
          setActiveView("recordings");
        }}
        onCancel={() => {
          setShowOverviewPromptModal(false);
        }}
      />
    </div>
  );
}
