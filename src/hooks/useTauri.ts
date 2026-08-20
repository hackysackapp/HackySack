// ============================================================
// src/hooks/useTauri.ts — TAURI COMMAND BRIDGE HOOK
// ============================================================
//
// This custom React hook wraps all Tauri `invoke()` calls in one place.
// Instead of scattering `invoke('ask_ai', {...})` calls across your components,
// you import this hook and get typed, clean function calls.
//
// Usage in any component:
//   const { askAI, ping, loading, error } = useTauri();
//   const result = await askAI({ prompt: "Tell me about yourself" });

import { useState, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";

// Type Definitions (mirrors the Rust structs in state.rs)

export interface DualTranscriptionResponse {
  interviewer_text: string;
  candidate_text: string;
}

export type ContextKind = "Audio" | "Screenshot" | "Text" | "Document";

export interface ContextItem {
  id: string;
  kind: ContextKind;
  content: string;
  timestamp: number;
}

export interface AIResponse {
  content: string;
  model_used: string;
  tokens_used: number;
  success: boolean;
  question?: string;
  kind?: "auto" | "manual";
}

export interface ModelInfo {
  id: string;
  name: string;
  provider: string;
}

export interface StealthStatus {
  protected: boolean;
  platform: string;
}

export interface TranscriptionResponse {
  text: string;
}

// The Hook

export function useTauri() {
  const [loading, setLoading] = useState(false);
  const [transcribeLoading, setTranscribeLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Generic invoke wrapper — handles loading state and errors
  const call = useCallback(async <T>(
    command: string,
    args?: Record<string, unknown>,
    isSilent = false
  ): Promise<T | null> => {
    if (!isSilent) setLoading(true);
    setError(null);
    try {
      const result = await invoke<T>(command, args);
      return result;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setError(message);
      console.error(`[Tauri] Command '${command}' failed:`, message);
      return null;
    } finally {
      if (!isSilent) setLoading(false);
    }
  }, []);

  // Typed Command Wrappers

  const ping = useCallback(
    (message: string) => call<string>("ping", { message }),
    [call]
  );

  const askAI = useCallback(
    (params: {
      prompt: string;
      contextItems?: ContextItem[];
      model?: string;
    }) =>
      call<AIResponse>("ask_ai", {
        prompt: params.prompt,
        contextItems: params.contextItems ?? [],
        model: params.model ?? null,
      }),
    [call]
  );

  const askAIStream = useCallback(
    (params: {
      prompt: string;
      contextItems?: ContextItem[];
      model?: string;
    }) =>
      call<void>("ask_ai_stream", {
        prompt: params.prompt,
        contextItems: params.contextItems ?? [],
        model: params.model ?? null,
      }, true),
    [call]
  );

  const setApiKey = useCallback(
    (key: string, provider: string, transcriptionKey?: string) =>
      call<null>("set_api_key", { key, provider, transcriptionKey: transcriptionKey ?? null }),
    [call]
  );

  const getAvailableModels = useCallback(
    () => call<ModelInfo[]>("get_available_models"),
    [call]
  );

  const transcribeAudio = useCallback(
    async (audioBytes: number[], mimeType?: string) => {
      setTranscribeLoading(true);
      try {
        const res = await call<TranscriptionResponse>("transcribe_audio", { audioBytes, mimeType: mimeType ?? null }, false);
        if (!res) {
           console.error("transcribeAudio returned null!");
        }
        return res;
      } finally {
        setTranscribeLoading(false);
      }
    },
    [call]
  );

  const startNativeRecording = useCallback(
    (micDevice?: string, speakerDevice?: string) =>
      call<void>("start_native_recording", {
        micDevice: micDevice ?? null,
        speakerDevice: speakerDevice ?? null,
      }),
    [call]
  );

  const transcribeDualNative = useCallback(async (isStop: boolean = false) => {
    try {
      return await invoke<any>("transcribe_dual_native", { isStop });
    } catch (err: any) {
      console.error("Dual transcription failed:", err);
      return { error: err.toString() };
    }
  }, []);

  const stopNativeRecording = useCallback(
    () => call<void>("stop_native_recording"),
    [call]
  );

  const captureScreenshot = useCallback(
    () => call<{ success: boolean; context_item_id: string | null }>("capture_screenshot"),
    [call]
  );

  const setScreenProtection = useCallback(
    (protect: boolean) => call<StealthStatus>("set_screen_protection", { protect }),
    [call]
  );

  const setAlwaysOnTop = useCallback(
    (alwaysOnTop: boolean) => call<boolean>("set_always_on_top", { alwaysOnTop }),
    [call]
  );

  const setClickThrough = useCallback(
    (ignore: boolean) => call<boolean>("set_click_through", { ignore }),
    [call]
  );

  const getScreenProtectionStatus = useCallback(
    () => call<StealthStatus>("get_screen_protection_status"),
    [call]
  );

  const setInteractiveRegions = useCallback(
    (regions: { x: number; y: number; width: number; height: number }[]) =>
      call<void>("set_interactive_regions", { regions }, true),
    [call]
  );

  const parseDocument = useCallback(
    (fileBytes: number[], fileName: string) =>
      call<string>("parse_document", { fileBytes, fileName }),
    [call]
  );

  const saveContextDocument = useCallback(
    (docType: string, fileName: string, fileBytes: number[]) =>
      call<string>("save_context_document", { docType, fileName, fileBytes }),
    [call]
  );

  const openFilePath = useCallback(
    (filePath: string) =>
      call<void>("open_file_path", { filePath }),
    [call]
  );

  const saveSecureKey = useCallback(
    (keyName: string, secret: string) => call<void>("save_secure_key", { keyName, secret }),
    [call]
  );

  const getSecureKey = useCallback(
    (keyName: string) => call<string | null>("get_secure_key", { keyName }),
    [call]
  );

  const deleteSecureKey = useCallback(
    (keyName: string) => call<void>("delete_secure_key", { keyName }),
    [call]
  );

  return {
    // State
    loading,
    transcribeLoading,
    error,
    // Commands
    ping,
    askAI,
    askAIStream,
    setApiKey,
    getAvailableModels,
    transcribeAudio,
    transcribeDualNative,
    startNativeRecording,
    stopNativeRecording,
    captureScreenshot,
    setScreenProtection,
    setAlwaysOnTop,
    setClickThrough,
    getScreenProtectionStatus,
    setInteractiveRegions,
    parseDocument,
    saveContextDocument,
    openFilePath,
    saveSecureKey,
    getSecureKey,
    deleteSecureKey,
  };
}
