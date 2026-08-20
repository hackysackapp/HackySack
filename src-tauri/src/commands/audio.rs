// Dual-channel audio capture, earshot neural VAD, and Whisper transcription

use std::sync::{Arc, Mutex};
use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use once_cell::sync::Lazy;
use tauri::{State, Emitter, Manager};
use crate::state::{AppState, AIProvider};
use serde::{Deserialize, Serialize};
use tokio::sync::watch;

#[derive(Debug, Serialize, Deserialize)]
pub struct TranscriptionResponse {
    pub text: String,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct DualTranscriptionResponse {
    pub interviewer_text: String,
    pub candidate_text: String,
}

pub struct NativeRecorderState {
    pub mic_stream: Option<cpal::Stream>,
    pub speaker_stream: Option<cpal::Stream>,
    pub mic_pcm: Arc<Mutex<Vec<f32>>>,
    pub speaker_pcm: Arc<Mutex<Vec<f32>>>,
    pub mic_read_offset: usize,
    pub speaker_read_offset: usize,
    pub is_recording: bool,
    /// Signals the background VAD loop to stop (send false → loop exits)
    pub vad_stop_tx: Option<watch::Sender<bool>>,
}

unsafe impl Send for NativeRecorderState {}
unsafe impl Sync for NativeRecorderState {}

static RECORDER: Lazy<Mutex<NativeRecorderState>> = Lazy::new(|| {
    Mutex::new(NativeRecorderState {
        mic_stream: None,
        speaker_stream: None,
        mic_pcm: Arc::new(Mutex::new(Vec::new())),
        speaker_pcm: Arc::new(Mutex::new(Vec::new())),
        mic_read_offset: 0,
        speaker_read_offset: 0,
        is_recording: false,
        vad_stop_tx: None,
    })
});

fn append_resampled(
    target_buf: &Arc<Mutex<Vec<f32>>>,
    data: &[f32],
    channels: usize,
    in_rate: u32,
    out_rate: u32,
) {
    if channels == 0 || in_rate == 0 || data.is_empty() {
        return;
    }

    let num_frames = data.len() / channels;
    if num_frames == 0 {
        return;
    }

    let step = in_rate as f64 / out_rate as f64;
    let mut resampled = Vec::with_capacity((num_frames as f64 / step) as usize + 1);
    let mut pos = 0.0;

    while (pos as usize) < num_frames {
        let idx0 = pos as usize;
        let idx1 = (idx0 + 1).min(num_frames - 1);
        let frac = (pos - idx0 as f64) as f32;

        let s0 = data[idx0 * channels];
        let s1 = data[idx1 * channels];

        let s0_clean = if s0.is_nan() || s0.is_infinite() { 0.0 } else { s0 };
        let s1_clean = if s1.is_nan() || s1.is_infinite() { 0.0 } else { s1 };

        let sample = s0_clean + frac * (s1_clean - s0_clean);
        resampled.push(sample);

        pos += step;
    }

    if !resampled.is_empty() {
        if let Ok(mut lock) = target_buf.lock() {
            // Buffer safety cap: 10 minutes at 16kHz (9,600,000 samples ~ 38MB RAM)
            let max_samples = 16000 * 600;
            if lock.len() + resampled.len() > max_samples {
                let overflow = (lock.len() + resampled.len()) - max_samples;
                if overflow < lock.len() {
                    lock.drain(0..overflow);
                } else {
                    lock.clear();
                }
            }
            lock.extend(resampled);
        }
    }
}

fn encode_pcm_to_wav(pcm_samples: &[f32]) -> Result<Vec<u8>, String> {
    let spec = hound::WavSpec {
        channels: 1,
        sample_rate: 16000,
        bits_per_sample: 16,
        sample_format: hound::SampleFormat::Int,
    };

    let mut cursor = std::io::Cursor::new(Vec::new());
    {
        let mut writer = hound::WavWriter::new(&mut cursor, spec)
            .map_err(|e| format!("Failed to create WavWriter: {}", e))?;
        for &sample in pcm_samples {
            let sanitized = if sample.is_nan() || sample.is_infinite() { 0.0 } else { sample };
            let clamped = sanitized.clamp(-1.0, 1.0);
            let s_i16 = (clamped * 32767.0) as i16;
            writer.write_sample(s_i16)
                .map_err(|e| format!("Failed to write sample: {}", e))?;
        }
        writer.finalize()
            .map_err(|e| format!("Failed to finalize WAV: {}", e))?;
    }

    Ok(cursor.into_inner())
}

/// ── VAD constants ────────────────────────────────────────────
const VAD_FRAME: usize = 256;
const SPEECH_THRESHOLD: f32 = 0.5;
const SILENCE_THRESHOLD: f32 = 0.5;
const SILENCE_FRAMES_TO_END: usize = 45; // ~720ms natural pause before flushing (prevents sentence fragmentation)
const MIN_SPEECH_FRAMES: usize = 16;      // ~256ms minimum speech duration (filters noise/clicks)
const MAX_SPEECH_SAMPLES: usize = 16000 * 30;

struct AdaptivePeakVad {
    noise_floor: f32,
    frame_count: usize,
    name: String,
}

impl AdaptivePeakVad {
    fn new(name: &str) -> Self {
        Self { noise_floor: 0.003, frame_count: 0, name: name.to_string() }
    }
    
    fn predict_f32(&mut self, frame: &[f32]) -> f32 {
        self.frame_count += 1;
        let max_peak = frame.iter().fold(0.0f32, |m, &s| m.max(s.abs()));
        
        // Adaptive noise floor tracking with a strict minimum sanity floor (0.0015)
        if max_peak < self.noise_floor {
            self.noise_floor = (self.noise_floor * 0.98 + max_peak * 0.02).max(0.0015);
        } else {
            self.noise_floor = (self.noise_floor * 0.9995 + max_peak * 0.0005).min(0.05);
        }
        
        // Speech must be clearly above background noise floor AND meet a real vocal volume threshold (0.006)
        let is_speech = max_peak > (self.noise_floor + 0.002) && max_peak > 0.006;
        
        if self.frame_count % 200 == 0 {
            println!("[VAD-DEBUG {}] max_peak: {:.4}, noise_floor: {:.4}, is_speech: {}", self.name, max_peak, self.noise_floor, is_speech);
        }
        
        if is_speech {
            1.0
        } else {
            0.0
        }
    }
}

/// Earshot neural VAD background loop.
/// Reads freshly appended PCM samples from mic and speaker buffers in 256-sample frames,
/// runs the earshot neural network VAD on each frame, and when a full utterance ends
/// (VAD probability drops below SILENCE_THRESHOLD for SILENCE_FRAMES_TO_END consecutive
/// frames), sends the accumulated samples to Whisper and emits a "live-transcript" event.
async fn vad_loop(
    mic_buf: Arc<Mutex<Vec<f32>>>,
    speaker_buf: Arc<Mutex<Vec<f32>>>,
    app_handle: tauri::AppHandle,
    mut stop_rx: watch::Receiver<bool>,
) {
    let mut mic_vad = AdaptivePeakVad::new("MIC");
    let mut speaker_vad = AdaptivePeakVad::new("SPK");

    // Read cursors — we consume from these offsets going forward
    let mut mic_offset: usize = 0;
    let mut spk_offset: usize = 0;

    // VAD state machine per channel
    let mut mic_speech: Vec<f32> = Vec::new();
    let mut mic_speech_frames: usize = 0;
    let mut mic_silence_count: usize = 0;
    let mut mic_speaking = false;

    let mut spk_speech: Vec<f32> = Vec::new();
    let mut spk_speech_frames: usize = 0;
    let mut spk_silence_count: usize = 0;
    let mut spk_speaking = false;

    // Pre-speech ring buffers (stores up to 12 frames ~ 192ms of audio before speech onset to prevent initial consonant clipping)
    let mut mic_ring_buffer: std::collections::VecDeque<Vec<f32>> = std::collections::VecDeque::with_capacity(12);
    let mut spk_ring_buffer: std::collections::VecDeque<Vec<f32>> = std::collections::VecDeque::with_capacity(12);

    // Load API key / cloud config once (will re-read from keyring each segment)
    loop {
        // Check stop signal
        if *stop_rx.borrow() {
            break;
        }

        // Sleep 8ms between ticks (half a VAD frame — responsive but CPU-friendly)
        tokio::select! {
            _ = tokio::time::sleep(tokio::time::Duration::from_millis(8)) => {}
            _ = stop_rx.changed() => { break; }
        }

        // ── Process MIC frames ───────────────────────────────────────────────
        loop {
            let frame: Option<Vec<f32>> = {
                if let Ok(lock) = mic_buf.lock() {
                    let available = lock.len().saturating_sub(mic_offset);
                    if available >= VAD_FRAME {
                        let frame = lock[mic_offset..mic_offset + VAD_FRAME].to_vec();
                        Some(frame)
                    } else {
                        None
                    }
                } else {
                    None
                }
            };
            let frame = match frame {
                Some(f) => f,
                None => break,
            };
            mic_offset += VAD_FRAME;

            let prob = mic_vad.predict_f32(&frame);

            if !mic_speaking {
                if prob >= SPEECH_THRESHOLD {
                    println!("[VAD-MIC] Speech started (peak > noise floor + 0.002)");
                    mic_speaking = true;
                    mic_silence_count = 0;
                    mic_speech.clear();
                    mic_speech_frames = 0;

                    // Prepend pre-speech ring buffer to preserve onset consonants (e.g. W, T, P, S)
                    for f in &mic_ring_buffer {
                        mic_speech.extend_from_slice(f);
                        mic_speech_frames += 1;
                    }
                    mic_speech.extend_from_slice(&frame);
                    mic_speech_frames += 1;
                } else {
                    if mic_ring_buffer.len() >= 12 {
                        mic_ring_buffer.pop_front();
                    }
                    mic_ring_buffer.push_back(frame.clone());
                }
            } else {
                mic_speech.extend_from_slice(&frame);
                mic_speech_frames += 1;

                if prob < SILENCE_THRESHOLD {
                    mic_silence_count += 1;
                } else {
                    mic_silence_count = 0;
                }

                let should_flush = mic_silence_count >= SILENCE_FRAMES_TO_END
                    || mic_speech.len() >= MAX_SPEECH_SAMPLES;

                if should_flush {
                    println!("[VAD-MIC] Speech ended. Flushing {} samples to Whisper.", mic_speech.len());
                    mic_speaking = false;
                    mic_silence_count = 0;
                    if mic_speech_frames >= MIN_SPEECH_FRAMES {
                        let samples = std::mem::take(&mut mic_speech);
                        let app = app_handle.clone();
                        tokio::spawn(async move {
                            if let Ok(wav) = encode_pcm_to_wav(&samples) {
                                match send_to_whisper(wav, &app).await {
                                    Ok(text) => {
                                        let cleaned = clean_whisper_hallucinations(&text);
                                        if !cleaned.is_empty() {
                                            eprintln!("[VAD-MIC] Emitting: '{}'", &cleaned.chars().take(80).collect::<String>());
                                            let _ = app.emit("live-transcript", serde_json::json!({
                                                "speaker": "you",
                                                "text": cleaned
                                            }));
                                        }
                                    }
                                    Err(err) => {
                                        eprintln!("[VAD-MIC] send_to_whisper error: {}", err);
                                    }
                                }
                            }
                        });
                    } else {
                        mic_speech.clear();
                    }
                    mic_speech_frames = 0;
                }
            }
        }

        // ── Process SPEAKER frames ───────────────────────────────────────────
        loop {
            let frame: Option<Vec<f32>> = {
                if let Ok(lock) = speaker_buf.lock() {
                    let available = lock.len().saturating_sub(spk_offset);
                    if available >= VAD_FRAME {
                        let frame = lock[spk_offset..spk_offset + VAD_FRAME].to_vec();
                        Some(frame)
                    } else {
                        None
                    }
                } else {
                    None
                }
            };
            let frame = match frame {
                Some(f) => f,
                None => break,
            };
            spk_offset += VAD_FRAME;

            let prob = speaker_vad.predict_f32(&frame);

            if !spk_speaking {
                if prob >= SPEECH_THRESHOLD {
                    println!("[VAD-SPK] Speech started (peak > noise floor + 0.002)");
                    spk_speaking = true;
                    spk_silence_count = 0;
                    spk_speech.clear();
                    spk_speech_frames = 0;

                    // Prepend pre-speech ring buffer to preserve onset consonants
                    for f in &spk_ring_buffer {
                        spk_speech.extend_from_slice(f);
                        spk_speech_frames += 1;
                    }
                    spk_speech.extend_from_slice(&frame);
                    spk_speech_frames += 1;
                } else {
                    if spk_ring_buffer.len() >= 12 {
                        spk_ring_buffer.pop_front();
                    }
                    spk_ring_buffer.push_back(frame.clone());
                }
            } else {
                spk_speech.extend_from_slice(&frame);
                spk_speech_frames += 1;

                if prob < SILENCE_THRESHOLD {
                    spk_silence_count += 1;
                } else {
                    spk_silence_count = 0;
                }

                let should_flush = spk_silence_count >= SILENCE_FRAMES_TO_END
                    || spk_speech.len() >= MAX_SPEECH_SAMPLES;

                if should_flush {
                    println!("[VAD-SPK] Speech ended. Flushing {} samples to Whisper.", spk_speech.len());
                    spk_speaking = false;
                    spk_silence_count = 0;
                    if spk_speech_frames >= MIN_SPEECH_FRAMES {
                        let samples = std::mem::take(&mut spk_speech);
                        let app = app_handle.clone();
                        tokio::spawn(async move {
                            if let Ok(wav) = encode_pcm_to_wav(&samples) {
                                match send_to_whisper(wav, &app).await {
                                    Ok(text) => {
                                        let cleaned = clean_whisper_hallucinations(&text);
                                        if !cleaned.is_empty() {
                                            eprintln!("[VAD-SPK] Emitting: '{}'", &cleaned.chars().take(80).collect::<String>());
                                            let _ = app.emit("live-transcript", serde_json::json!({
                                                "speaker": "them",
                                                "text": cleaned
                                            }));
                                        }
                                    }
                                    Err(err) => {
                                        eprintln!("[VAD-SPK] send_to_whisper error: {}", err);
                                    }
                                }
                            }
                        });
                    } else {
                        spk_speech.clear();
                    }
                    spk_speech_frames = 0;
                }
            }
        }
    }
    eprintln!("[VAD] earshot VAD loop exited.");
}

/// Sends a WAV byte buffer to the Whisper API using AppState resolution.
async fn send_to_whisper(wav_bytes: Vec<u8>, app_handle: &tauri::AppHandle) -> Result<String, String> {
    let state = app_handle.state::<AppState>();

    let is_cloud = {
        let mode_guard = state.use_cloud_mode.lock().map_err(|e| e.to_string())?;
        *mode_guard
    };

    let cloud_jwt = {
        let jwt_guard = state.cloud_jwt.lock().map_err(|e| e.to_string())?;
        jwt_guard.clone()
    };

    let api_key = if is_cloud && cloud_jwt.as_ref().map(|k| !k.trim().is_empty()).unwrap_or(false) {
        cloud_jwt
    } else {
        let t_guard = state.transcription_api_key.lock().map_err(|e| e.to_string())?;
        let key_guard = state.api_key.lock().map_err(|e| e.to_string())?;
        
        let local_t_key = t_guard.clone();
        let local_ai_key = key_guard.clone();

        if let Some(ref k) = local_t_key {
            if !k.trim().is_empty() {
                Some(k.clone())
            } else {
                local_ai_key
            }
        } else {
            local_ai_key
        }
    };

    let api_key = match api_key {
        Some(k) if !k.trim().is_empty() => k,
        _ => return Err("No API key configured for Whisper transcription".to_string()),
    };

    let is_cloud_key = is_cloud || api_key.starts_with("hs_cloud_");

    let (url, model) = if is_cloud_key {
        let endpoint_guard = state.cloud_endpoint.lock().map_err(|e| e.to_string())?;
        let endpoint = if endpoint_guard.is_empty() {
            "https://vzuutupafqjrmfuncgxl.supabase.co/functions/v1/ai-proxy".to_string()
        } else {
            endpoint_guard.clone()
        };
        (
            format!("{}/audio/transcriptions", endpoint),
            "whisper-large-v3-turbo".to_string()
        )
    } else {
        let provider_guard = state.ai_provider.lock().map_err(|e| e.to_string())?;
        let (u, m) = resolve_whisper_endpoint(&api_key, &provider_guard)?;
        (u.to_string(), m.to_string())
    };

    let client = reqwest::Client::new();
    let part = reqwest::multipart::Part::bytes(wav_bytes)
        .file_name("audio.wav")
        .mime_str("audio/wav")
        .map_err(|e| e.to_string())?;

    let form = reqwest::multipart::Form::new()
        .part("file", part)
        .text("model", model)
        .text("language", "en")
        .text("prompt", "Technical software engineering job interview dialogue covering SQL, React, TypeScript, Python, Java, C++, Go, AWS, Azure, Docker, Kubernetes, Rust, APIs, databases, microservices, and system design architecture.")
        .text("temperature", "0.0");

    let res = client.post(&url)
        .header("Authorization", format!("Bearer {}", api_key))
        .multipart(form)
        .send()
        .await
        .map_err(|e| e.to_string())?;

    if res.status().is_success() {
        let json: serde_json::Value = res.json().await.map_err(|e| e.to_string())?;
        let text = json["text"].as_str().unwrap_or("").trim().to_string();
        Ok(text)
    } else {
        let status = res.status();
        let body = res.text().await.unwrap_or_default();
        eprintln!("[VAD] Whisper API error (status {}): {}", status, body);
        // Emit a warning event so the UI can show the API error without polluting transcript
        let _ = app_handle.emit("api-error", format!("Transcription error ({}). Check your API key.", status));
        Err(format!("Whisper error {}: {}", status, body))
    }
}

fn clean_whisper_hallucinations(text: &str) -> String {
    // 1. Instantly reject foreign non-Latin script hallucinations (e.g. Russian Cyrillic, CJK, Arabic)
    // while permitting Latin extended & standard General Punctuation (e.g. smart apostrophe ’ U+2019, quotes, dashes)
    let is_non_latin_script = |c: char| -> bool {
        let cp = c as u32;
        (0x0400..=0x04FF).contains(&cp) || // Cyrillic
        (0x0590..=0x05FF).contains(&cp) || // Hebrew
        (0x0600..=0x06FF).contains(&cp) || // Arabic
        (0x0900..=0x097F).contains(&cp) || // Devanagari
        (0x0E00..=0x0E7F).contains(&cp) || // Thai
        (0x3040..=0x30FF).contains(&cp) || // Hiragana / Katakana
        (0x4E00..=0x9FFF).contains(&cp) || // CJK Unified Ideographs
        (0xAC00..=0xD7AF).contains(&cp)    // Hangul
    };
    if text.chars().any(is_non_latin_script) {
        return String::new();
    }

    // Remove the hallucinated prompt text anywhere in the string
    let mut cleaned = text.replace("Transcribe the spoken audio verbatim.", "");
    cleaned = cleaned.replace("Interview dialogue, technical conversation.", "");
    cleaned = cleaned.replace("English job interview dialogue.", "");
    
    let trimmed = cleaned.trim();

    // Reject empty strings or non-alphanumeric noise strings (e.g. "." or "...")
    if trimmed.is_empty() || !trimmed.chars().any(|c| c.is_alphanumeric()) {
        return String::new();
    }

    let lower = trimmed.to_lowercase();
    let lower_clean = lower.chars().filter(|c| c.is_alphanumeric() || c.is_whitespace()).collect::<String>().trim().to_string();

    // Common Whisper background static / silence hallucinations on quiet audio
    let hallucinations = [
        "thank you",
        "thanks for watching",
        "thank you for watching",
        "thank you very much",
        "thank you so much",
        "thanks",
        "subtitles by",
        "amara.org",
        "mbc news",
        "bye",
        "subscribe",
        "watching",
        "transcribe the spoken audio verbatim",
        "you",
        "like and subscribe",
        "see you next time",
        "and well see you in the next one",
        "well see you in the next one",
        "see you in the next one",
        "and we will see you in the next one",
        "cameraman",
        "edited by",
        "captioned by",
        "translated by",
        "silence",
        "music",
        "applause",
    ];

    for h in &hallucinations {
        if lower_clean == *h || lower == *h {
            return String::new();
        }
    }

    if lower.contains("subtitles by") || lower.contains("amara.org") || lower.contains("thanks for watching") || lower.contains("thank you for watching") || lower.contains("see you in the next") || lower.contains("invalid_api_key") || lower.contains("platform.openai.com") {
        return String::new();
    }

    // Filter single-word / phrase silence hallucinations
    if lower_clean == "thank you" || lower_clean == "thanks" || lower_clean == "thank you very much" || lower_clean == "thank you so much" {
        return String::new();
    }

    // Simple deduplication of consecutive identical sentences (fixes Whisper repetition loops)
    let mut sentences: Vec<&str> = trimmed.split_inclusive(|c| c == '.' || c == '?' || c == '!').collect();
    sentences.dedup_by(|a, b| a.trim().eq_ignore_ascii_case(b.trim()));
    
    // Also check if the string is just exactly duplicated in halves (e.g. "Hello Hello")
    let joined = sentences.join(" ").trim().to_string();
    let words: Vec<&str> = joined.split_whitespace().collect();
    if words.len() > 0 && words.len() % 2 == 0 {
        let half = words.len() / 2;
        if words[..half] == words[half..] {
            return words[..half].join(" ");
        }
    }
    
    joined
}

fn resolve_whisper_endpoint(api_key: &str, provider: &AIProvider) -> Result<(&'static str, &'static str), String> {
    if api_key.starts_with("gsk_") {
        Ok((
            "https://api.groq.com/openai/v1/audio/transcriptions",
            "whisper-large-v3-turbo"
        ))
    } else if api_key.starts_with("sk-") && !api_key.starts_with("sk-or-") && !api_key.starts_with("sk-ant-") {
        Ok((
            "https://api.openai.com/v1/audio/transcriptions",
            "whisper-1"
        ))
    } else if api_key.starts_with("sk-or-") || api_key.starts_with("sk-ant-") {
        Err("OpenRouter and Anthropic keys do not support audio transcription directly. Please enter a free Groq (gsk_...) or OpenAI (sk-...) transcription key.".to_string())
    } else {
        match provider {
            AIProvider::Groq => Ok((
                "https://api.groq.com/openai/v1/audio/transcriptions",
                "whisper-large-v3-turbo"
            )),
            AIProvider::OpenAI => Ok((
                "https://api.openai.com/v1/audio/transcriptions",
                "whisper-1"
            )),
            _ => Err("Transcription requires a valid Groq (gsk_...) or OpenAI (sk-...) API key.".to_string()),
        }
    }
}

/// Starts mic + speaker loopback recording with real-time level events
#[tauri::command]
pub async fn start_native_recording(
    app_handle: tauri::AppHandle,
    mic_device: Option<String>,
    speaker_device: Option<String>,
) -> Result<(), String> {
    let mut recorder = RECORDER.lock().map_err(|e| e.to_string())?;

    // If already running, cleanly drop existing streams and restart on the new hardware device
    if recorder.is_recording {
        println!("Native recorder re-initializing with updated audio hardware device...");
        recorder.mic_stream = None;
        recorder.speaker_stream = None;
        if let Some(tx) = recorder.vad_stop_tx.take() {
            let _ = tx.send(true);
        }
    }

    let mic_buf = Arc::new(Mutex::new(Vec::new()));
    let speaker_buf = Arc::new(Mutex::new(Vec::new()));
    recorder.mic_pcm = mic_buf.clone();
    recorder.speaker_pcm = speaker_buf.clone();
    recorder.mic_read_offset = 0;
    recorder.speaker_read_offset = 0;

    let host = cpal::default_host();

    // Find requested or default microphone device
    let mic_dev = if let Some(ref target) = mic_device {
        if !target.is_empty() && target != "default" {
            host.input_devices().ok().and_then(|mut devs| {
                devs.find(|d| d.name().map(|n| n.contains(target) || target.contains(&n)).unwrap_or(false))
            }).or_else(|| host.default_input_device())
        } else {
            host.default_input_device()
        }
    } else {
        host.default_input_device()
    };

    // 1. Microphone Input Stream (You / Candidate)
    let mut mic_stream = None;
    if let Some(mic_d) = mic_dev {
        if let Ok(config) = mic_d.default_input_config() {
            let sample_rate = config.sample_rate().0;
            let channels = config.channels() as usize;
            let buf_clone = mic_buf.clone();
            let app_handle_mic = app_handle.clone();

            let app_handle_mic_err = app_handle.clone();
            let err_fn = move |err| {
                eprintln!("Mic stream error: {}", err);
                let _ = app_handle_mic_err.emit("audio-device-warning", format!("Microphone notice: {}", err));
            };

            let mic_stream_opt = match config.sample_format() {
                cpal::SampleFormat::F32 => mic_d.build_input_stream(
                    &config.into(),
                    move |data: &[f32], _| {
                        append_resampled(&buf_clone, data, channels, sample_rate, 16000);
                        if !data.is_empty() {
                            let sum_sq: f32 = data.iter().map(|&s| s * s).sum();
                            let rms = (sum_sq / data.len() as f32).sqrt();
                            if rms > 0.00015 {
                                let _ = app_handle_mic.emit("audio-level", rms);
                            }
                        }
                    },
                    err_fn,
                    None
                ).ok(),
                cpal::SampleFormat::I16 => mic_d.build_input_stream(
                    &config.into(),
                    move |data: &[i16], _| {
                        let f32_data: Vec<f32> = data.iter().map(|&s| s as f32 / 32768.0).collect();
                        append_resampled(&buf_clone, &f32_data, channels, sample_rate, 16000);
                        if !f32_data.is_empty() {
                            let sum_sq: f32 = f32_data.iter().map(|&s| s * s).sum();
                            let rms = (sum_sq / f32_data.len() as f32).sqrt();
                            if rms > 0.00015 {
                                let _ = app_handle_mic.emit("audio-level", rms);
                            }
                        }
                    },
                    err_fn,
                    None
                ).ok(),
                cpal::SampleFormat::I32 => mic_d.build_input_stream(
                    &config.into(),
                    move |data: &[i32], _| {
                        let f32_data: Vec<f32> = data.iter().map(|&s| s as f32 / 2147483648.0).collect();
                        append_resampled(&buf_clone, &f32_data, channels, sample_rate, 16000);
                        if !f32_data.is_empty() {
                            let sum_sq: f32 = f32_data.iter().map(|&s| s * s).sum();
                            let rms = (sum_sq / f32_data.len() as f32).sqrt();
                            if rms > 0.00015 {
                                let _ = app_handle_mic.emit("audio-level", rms);
                            }
                        }
                    },
                    err_fn,
                    None
                ).ok(),
                cpal::SampleFormat::U16 => mic_d.build_input_stream(
                    &config.into(),
                    move |data: &[u16], _| {
                        let f32_data: Vec<f32> = data.iter().map(|&s| (s as f32 - 32768.0) / 32768.0).collect();
                        append_resampled(&buf_clone, &f32_data, channels, sample_rate, 16000);
                        if !f32_data.is_empty() {
                            let sum_sq: f32 = f32_data.iter().map(|&s| s * s).sum();
                            let rms = (sum_sq / f32_data.len() as f32).sqrt();
                            if rms > 0.00015 {
                                let _ = app_handle_mic.emit("audio-level", rms);
                            }
                        }
                    },
                    err_fn,
                    None
                ).ok(),
                fmt => {
                    eprintln!("Unsupported mic format: {:?}", fmt);
                    None
                }
            };

            if let Some(s) = mic_stream_opt {
                if s.play().is_ok() {
                    mic_stream = Some(s);
                    println!("Native mic capture stream active!");
                }
            }
        }
    }

    // Find requested or default speaker device
    let speaker_dev = if let Some(ref target) = speaker_device {
        if !target.is_empty() && target != "default" {
            host.output_devices().ok().and_then(|mut devs| {
                devs.find(|d| d.name().map(|n| n.contains(target) || target.contains(&n)).unwrap_or(false))
            }).or_else(|| host.default_output_device())
        } else {
            host.default_output_device()
        }
    } else {
        host.default_output_device()
    };

    // 2. Speaker Output Stream (Them / Interviewer)
    let mut speaker_stream = None;
    if let Some(spk_d) = speaker_dev {
        let config_res = spk_d
            .default_input_config()
            .or_else(|_| spk_d.default_output_config());

        if let Ok(config) = config_res {
            let sample_rate = config.sample_rate().0;
            let channels = config.channels() as usize;
            let buf_clone = speaker_buf.clone();
            let app_handle_speaker = app_handle.clone();

            let app_handle_spk_err = app_handle.clone();
            let err_fn = move |err| {
                eprintln!("WASAPI loopback error: {}", err);
                let _ = app_handle_spk_err.emit("audio-device-warning", format!("Speaker notice: {}", err));
            };

            let speaker_stream_opt = match config.sample_format() {
                cpal::SampleFormat::F32 => spk_d.build_input_stream(
                    &config.into(),
                    move |data: &[f32], _| {
                        append_resampled(&buf_clone, data, channels, sample_rate, 16000);
                        if !data.is_empty() {
                            let sum_sq: f32 = data.iter().map(|&s| s * s).sum();
                            let rms = (sum_sq / data.len() as f32).sqrt();
                            if rms > 0.00015 {
                                let _ = app_handle_speaker.emit("audio-level", rms);
                            }
                        }
                    },
                    err_fn,
                    None
                ).ok(),
                cpal::SampleFormat::I16 => spk_d.build_input_stream(
                    &config.into(),
                    move |data: &[i16], _| {
                        let f32_data: Vec<f32> = data.iter().map(|&s| s as f32 / 32768.0).collect();
                        append_resampled(&buf_clone, &f32_data, channels, sample_rate, 16000);
                        if !f32_data.is_empty() {
                            let sum_sq: f32 = f32_data.iter().map(|&s| s * s).sum();
                            let rms = (sum_sq / f32_data.len() as f32).sqrt();
                            if rms > 0.00015 {
                                let _ = app_handle_speaker.emit("audio-level", rms);
                            }
                        }
                    },
                    err_fn,
                    None
                ).ok(),
                cpal::SampleFormat::I32 => spk_d.build_input_stream(
                    &config.into(),
                    move |data: &[i32], _| {
                        let f32_data: Vec<f32> = data.iter().map(|&s| s as f32 / 2147483648.0).collect();
                        append_resampled(&buf_clone, &f32_data, channels, sample_rate, 16000);
                        if !f32_data.is_empty() {
                            let sum_sq: f32 = f32_data.iter().map(|&s| s * s).sum();
                            let rms = (sum_sq / f32_data.len() as f32).sqrt();
                            if rms > 0.00015 {
                                let _ = app_handle_speaker.emit("audio-level", rms);
                            }
                        }
                    },
                    err_fn,
                    None
                ).ok(),
                cpal::SampleFormat::U16 => spk_d.build_input_stream(
                    &config.into(),
                    move |data: &[u16], _| {
                        let f32_data: Vec<f32> = data.iter().map(|&s| (s as f32 - 32768.0) / 32768.0).collect();
                        append_resampled(&buf_clone, &f32_data, channels, sample_rate, 16000);
                        if !f32_data.is_empty() {
                            let sum_sq: f32 = f32_data.iter().map(|&s| s * s).sum();
                            let rms = (sum_sq / f32_data.len() as f32).sqrt();
                            if rms > 0.00015 {
                                let _ = app_handle_speaker.emit("audio-level", rms);
                            }
                        }
                    },
                    err_fn,
                    None
                ).ok(),
                fmt => {
                    eprintln!("Unsupported speaker format: {:?}", fmt);
                    None
                }
            };

            if let Some(s) = speaker_stream_opt {
                if s.play().is_ok() {
                    speaker_stream = Some(s);
                    println!("Native WASAPI loopback speaker output capture active!");
                }
            }
        }
    }

    if mic_stream.is_none() && speaker_stream.is_none() {
        return Err("No active microphone or speaker device could be initialized. Please check your audio hardware connections in Windows.".to_string());
    }

    // Create stop signal for background VAD task
    let (stop_tx, stop_rx) = watch::channel(false);
    recorder.vad_stop_tx = Some(stop_tx);

    recorder.mic_stream = mic_stream;
    recorder.speaker_stream = speaker_stream;
    recorder.is_recording = true;

    // Grab shared buffers and AppState reference for background task
    let mic_buf_vad = mic_buf.clone();
    let speaker_buf_vad = speaker_buf.clone();

    // Spawn the earshot neural VAD background task
    // This replaces the TypeScript 1-second polling loop entirely.
    let app_handle_vad = app_handle.clone();
    tokio::spawn(async move {
        vad_loop(mic_buf_vad, speaker_buf_vad, app_handle_vad, stop_rx).await;
    });

    println!("Start native dual channel recording + earshot VAD: ready!");

    Ok(())
}

/// Final-flush transcription: called ONLY when recording stops (is_stop=true).
/// The live transcript is now driven by the earshot VAD background task via Tauri events.
#[tauri::command]
pub async fn transcribe_dual_native(
    state: State<'_, AppState>,
    is_stop: bool,
) -> Result<DualTranscriptionResponse, String> {
    if !is_stop {
        // Live polls are no longer needed — earshot VAD emits events directly.
        return Ok(DualTranscriptionResponse {
            interviewer_text: String::new(),
            candidate_text: String::new(),
        });
    }

    // Final flush: grab whatever audio remains when the user clicks Stop
    let (speaker_pcm, mic_pcm) = {
        let mut recorder = match RECORDER.lock() {
            Ok(r) => r,
            Err(e) => return Err(format!("Recorder lock error: {}", e)),
        };

        recorder.is_recording = false;
        recorder.mic_stream = None;
        recorder.speaker_stream = None;
        // Signal VAD loop to exit
        if let Some(tx) = recorder.vad_stop_tx.take() {
            let _ = tx.send(true);
        }

        let s = if let Ok(mut lock) = recorder.speaker_pcm.lock() {
            std::mem::take(&mut *lock)
        } else {
            Vec::new()
        };
        let m = if let Ok(mut lock) = recorder.mic_pcm.lock() {
            std::mem::take(&mut *lock)
        } else {
            Vec::new()
        };
        recorder.speaker_read_offset = 0;
        recorder.mic_read_offset = 0;
        (s, m)
    };

    // Simple energy check for the final remaining audio
    let has_speaker_speech = !speaker_pcm.is_empty() && speaker_pcm.iter().any(|&s| s.abs() > 0.005);
    let has_mic_speech = !mic_pcm.is_empty() && mic_pcm.iter().any(|&s| s.abs() > 0.005);

    if !has_speaker_speech && !has_mic_speech {
        return Ok(DualTranscriptionResponse {
            interviewer_text: String::new(),
            candidate_text: String::new(),
        });
    }

    let is_cloud = {
        let mode_guard = state.use_cloud_mode.lock().map_err(|e| e.to_string())?;
        *mode_guard || crate::commands::ai::get_from_keyring("cloud_mode").map(|v| v == "true").unwrap_or(false)
    };

    let cloud_jwt = {
        let jwt_guard = state.cloud_jwt.lock().map_err(|e| e.to_string())?;
        jwt_guard.clone().or_else(|| crate::commands::ai::get_from_keyring("cloud_jwt"))
    };

    let api_key = if is_cloud && cloud_jwt.as_ref().map(|k| !k.trim().is_empty()).unwrap_or(false) {
        cloud_jwt
    } else {
        let t_guard = state.transcription_api_key.lock().map_err(|e| e.to_string())?;
        let key_guard = state.api_key.lock().map_err(|e| e.to_string())?;
        
        let local_t_key = t_guard.clone().or_else(|| crate::commands::ai::get_from_keyring("transcription_api_key"));
        let local_ai_key = key_guard.clone().or_else(|| crate::commands::ai::get_from_keyring("ai_api_key"));

        if let Some(ref k) = local_t_key {
            if !k.trim().is_empty() {
                Some(k.clone())
            } else {
                local_ai_key
            }
        } else {
            local_ai_key
        }
    };

    let api_key = match api_key {
        Some(key) => key,
        None => return Err("No API key set. Please set a Groq or OpenAI API key in Settings or enable Cloud Mode.".into()),
    };

    let is_cloud_key = is_cloud || api_key.starts_with("hs_cloud_");
    let is_valid_transcription_key = is_cloud_key || api_key.starts_with("gsk_") || 
        (api_key.starts_with("sk-") && !api_key.starts_with("sk-or-") && !api_key.starts_with("sk-ant-"));

    if !is_valid_transcription_key {
        return Err("The current AI provider does not support audio transcription. Please provide a free Groq API key in Settings or enable Cloud Mode.".into());
    }

    let (url, model_name) = if is_cloud_key {
        let endpoint_guard = state.cloud_endpoint.lock().map_err(|e| e.to_string())?;
        let endpoint = if endpoint_guard.is_empty() {
            "https://vzuutupafqjrmfuncgxl.supabase.co/functions/v1/ai-proxy".to_string()
        } else {
            endpoint_guard.clone()
        };
        eprintln!("[AUDIO] Using Cloud proxy for transcription: {}", endpoint);
        (endpoint, "whisper-large-v3-turbo".to_string())
    } else {
        let provider = {
            let p = state.ai_provider.lock().map_err(|e| e.to_string())?;
            p.clone()
        };
        let (u, m) = resolve_whisper_endpoint(&api_key, &provider)?;
        let key_preview: String = api_key.chars().take(8).collect();
        eprintln!("[AUDIO] Using BYOK key ({}...) => {} with model {}", key_preview, u, m);
        (u.to_string(), m.to_string())
    };

    let local_byok_key = {
        let t_guard = state.transcription_api_key.lock().ok();
        let key_guard = state.api_key.lock().ok();
        let local_t_key = t_guard.and_then(|g| g.clone()).or_else(|| crate::commands::ai::get_from_keyring("transcription_api_key"));
        let local_ai_key = key_guard.and_then(|g| g.clone()).or_else(|| crate::commands::ai::get_from_keyring("ai_api_key"));

        if let Some(ref k) = local_t_key {
            if k.starts_with("gsk_") || (k.starts_with("sk-") && !k.starts_with("sk-or-") && !k.starts_with("sk-ant-")) {
                Some(k.clone())
            } else {
                local_ai_key.filter(|k| k.starts_with("gsk_") || (k.starts_with("sk-") && !k.starts_with("sk-or-") && !k.starts_with("sk-ant-")))
            }
        } else {
            local_ai_key.filter(|k| k.starts_with("gsk_") || (k.starts_with("sk-") && !k.starts_with("sk-or-") && !k.starts_with("sk-ant-")))
        }
    };

    let client = reqwest::Client::new();

    let send_transcription = |wav_bytes: Vec<u8>| {
        let client_ref = client.clone();
        let api_key_ref = api_key.clone();
        let url_ref = url.to_string();
        let model_ref = model_name.to_string();
        let byok_key_ref = local_byok_key.clone();

        async move {
            let part = match reqwest::multipart::Part::bytes(wav_bytes.clone())
                .file_name("audio.wav")
                .mime_str("audio/wav") {
                    Ok(p) => p,
                    Err(e) => return Err(format!("Failed to create multipart WAV: {}", e)),
                };

            let form = reqwest::multipart::Form::new()
                .part("file", part)
                .text("model", model_ref.clone())
                .text("language", "en")
                .text("prompt", "English conversation and job interview dialogue.")
                .text("temperature", "0.0");

            let res = client_ref.post(&url_ref)
                .header("Authorization", format!("Bearer {}", api_key_ref))
                .multipart(form)
                .send()
                .await;

            match res {
                Ok(resp) => {
                    let status = resp.status();
                    if status.is_success() {
                        match resp.json::<serde_json::Value>().await {
                            Ok(json) => {
                                let raw = json["text"].as_str().unwrap_or("").trim();
                                let raw_preview: String = raw.chars().take(80).collect();
                                eprintln!("[AUDIO] Whisper returned: '{}'", raw_preview);
                                return Ok(clean_whisper_hallucinations(raw));
                            }
                            Err(e) => return Err(format!("Whisper JSON parse error: {}", e)),
                        }
                    } else {
                        let err_text = resp.text().await.unwrap_or_default();
                        eprintln!("[AUDIO] Whisper API error (status {}): {}", status, err_text);

                        // Automatic fallback to BYOK key if cloud mode token returned 403 / 401
                        if let Some(byok_key) = byok_key_ref {
                            if is_cloud_key {
                                eprintln!("[AUDIO] Cloud proxy failed (status {}). Attempting automatic BYOK key fallback...", status);
                                if let Ok((fallback_url, fallback_model)) = resolve_whisper_endpoint(&byok_key, &AIProvider::Groq) {
                                    if let Ok(part) = reqwest::multipart::Part::bytes(wav_bytes)
                                        .file_name("audio.wav")
                                        .mime_str("audio/wav")
                                    {
                                        let form = reqwest::multipart::Form::new()
                                            .part("file", part)
                                            .text("model", fallback_model.to_string());

                                        if let Ok(byok_res) = client_ref.post(fallback_url)
                                            .header("Authorization", format!("Bearer {}", byok_key))
                                            .multipart(form)
                                            .send()
                                            .await
                                        {
                                            if byok_res.status().is_success() {
                                                if let Ok(json) = byok_res.json::<serde_json::Value>().await {
                                                    let raw = json["text"].as_str().unwrap_or("").trim();
                                                    eprintln!("[AUDIO] BYOK Fallback Whisper returned: '{}'", raw.chars().take(80).collect::<String>());
                                                    return Ok(clean_whisper_hallucinations(raw));
                                                }
                                            }
                                        }
                                    }
                                }
                            }
                        }

                        let clean_err = if err_text.contains("Invalid, expired, or inactive") {
                            "Invalid, expired, or inactive HackySack Cloud token. Please renew token or set a free Groq key in Settings.".to_string()
                        } else {
                            format!("API error (status {}): {}", status, err_text)
                        };
                        return Err(clean_err);
                    }
                }
                Err(e) => return Err(format!("Whisper request network error: {}", e)),
            }
        }
    };

    let speaker_fut = async {
        if has_speaker_speech {
            if let Ok(wav) = encode_pcm_to_wav(&speaker_pcm) {
                return send_transcription(wav).await;
            }
        }
        Ok(String::new())
    };

    let mic_fut = async {
        if has_mic_speech {
            if let Ok(wav) = encode_pcm_to_wav(&mic_pcm) {
                return send_transcription(wav).await;
            }
        }
        Ok(String::new())
    };

    // Parallel execution of both transcriptions simultaneously
    let (speaker_res, mic_res) = tokio::join!(speaker_fut, mic_fut);

    let interviewer_text = match speaker_res {
        Ok(t) => t,
        Err(e) => return Err(e),
    };
    let candidate_text = match mic_res {
        Ok(t) => t,
        Err(e) => return Err(e),
    };

    // If we got a non-empty transcription during live polling (not stop), drain the buffers
    // so the NEXT poll only sees fresh new audio. Without this, the same speech audio stays
    // in the 6-second window and Whisper re-transcribes it (often with a hallucination).
    let got_result = !interviewer_text.is_empty() || !candidate_text.is_empty();
    if got_result && !is_stop {
        if let Ok(recorder) = RECORDER.lock() {
            if let Ok(mut lock) = recorder.speaker_pcm.lock() {
                lock.clear();
            }
            if let Ok(mut lock) = recorder.mic_pcm.lock() {
                lock.clear();
            }
        }
    }

    Ok(DualTranscriptionResponse {
        interviewer_text,
        candidate_text,
    })
}

/// Stops all audio streams, signals the VAD loop, and clears PCM buffers
#[tauri::command]
pub async fn stop_native_recording() -> Result<(), String> {
    let mut recorder = RECORDER.lock().map_err(|e| e.to_string())?;

    recorder.is_recording = false;
    recorder.mic_stream = None;
    recorder.speaker_stream = None;

    // Signal earshot VAD background loop to exit
    if let Some(tx) = recorder.vad_stop_tx.take() {
        let _ = tx.send(true);
    }

    let _ = recorder.mic_pcm.lock().map_err(|e| e.to_string())?.drain(..);
    let _ = recorder.speaker_pcm.lock().map_err(|e| e.to_string())?.drain(..);
    recorder.mic_read_offset = 0;
    recorder.speaker_read_offset = 0;

    Ok(())
}

/// Sends raw audio bytes to a Whisper-compatible transcription endpoint
#[tauri::command]
pub async fn transcribe_audio(
    state: State<'_, AppState>,
    audio_bytes: Vec<u8>,
    mime_type: Option<String>,
) -> Result<TranscriptionResponse, String> {
    let is_cloud = {
        let mode_guard = state.use_cloud_mode.lock().map_err(|e| e.to_string())?;
        *mode_guard || crate::commands::ai::get_from_keyring("cloud_mode").map(|v| v == "true").unwrap_or(false)
    };

    let cloud_jwt = {
        let jwt_guard = state.cloud_jwt.lock().map_err(|e| e.to_string())?;
        jwt_guard.clone().or_else(|| crate::commands::ai::get_from_keyring("cloud_jwt"))
    };

    let api_key = if is_cloud && cloud_jwt.as_ref().map(|k| !k.trim().is_empty()).unwrap_or(false) {
        cloud_jwt
    } else {
        let t_guard = state.transcription_api_key.lock().map_err(|e| e.to_string())?;
        let key_guard = state.api_key.lock().map_err(|e| e.to_string())?;
        
        let local_t_key = t_guard.clone().or_else(|| crate::commands::ai::get_from_keyring("transcription_api_key"));
        let local_ai_key = key_guard.clone().or_else(|| crate::commands::ai::get_from_keyring("ai_api_key"));

        if let Some(ref k) = local_t_key {
            if !k.trim().is_empty() {
                Some(k.clone())
            } else {
                local_ai_key
            }
        } else {
            local_ai_key
        }
    };

    let api_key = match api_key {
        Some(key) => key,
        None => return Err("No API key set. Please set a Groq or OpenAI API key in Settings or enable Cloud Mode.".into()),
    };

    let is_cloud_key = is_cloud || api_key.starts_with("hs_cloud_");
    let is_valid_transcription_key = is_cloud_key || api_key.starts_with("gsk_") || 
        (api_key.starts_with("sk-") && !api_key.starts_with("sk-or-") && !api_key.starts_with("sk-ant-"));

    if !is_valid_transcription_key {
        return Err("The current AI provider does not support audio transcription. Please provide a free Groq API key in Settings or enable Cloud Mode.".into());
    }

    let (url, model_name) = if is_cloud_key {
        let endpoint_guard = state.cloud_endpoint.lock().map_err(|e| e.to_string())?;
        let endpoint = if endpoint_guard.is_empty() {
            "https://vzuutupafqjrmfuncgxl.supabase.co/functions/v1/ai-proxy".to_string()
        } else {
            endpoint_guard.clone()
        };
        (endpoint, "whisper-large-v3-turbo".to_string())
    } else {
        let provider = {
            let p = state.ai_provider.lock().map_err(|e| e.to_string())?;
            p.clone()
        };
        let (u, m) = resolve_whisper_endpoint(&api_key, &provider)?;
        (u.to_string(), m.to_string())
    };

    let client = reqwest::Client::new();

    let mime = mime_type.unwrap_or_else(|| "audio/wav".to_string());
    let clean_mime = mime.split(';').next().unwrap_or(&mime).to_string();

    let part = reqwest::multipart::Part::bytes(audio_bytes)
        .file_name("audio.wav")
        .mime_str(&clean_mime)
        .map_err(|e| format!("Failed to create multipart body: {}", e))?;

    let form = reqwest::multipart::Form::new()
        .part("file", part)
        .text("model", model_name)
        .text("language", "en")
        .text("prompt", "English job interview dialogue.");

    let response = client
        .post(url)
        .header("Authorization", format!("Bearer {}", api_key))
        .multipart(form)
        .send()
        .await
        .map_err(|e| format!("Whisper request failed: {}", e))?;

    if !response.status().is_success() {
        let err_text = response.text().await.unwrap_or_default();
        return Err(format!("API error: {}", err_text));
    }

    let json: serde_json::Value = response
        .json()
        .await
        .map_err(|e| format!("Failed to parse response: {}", e))?;

    let raw = json["text"]
        .as_str()
        .unwrap_or("")
        .trim();

    let text = clean_whisper_hallucinations(raw);

    Ok(TranscriptionResponse { text })
}

#[derive(Debug, Serialize, Deserialize)]
pub struct AudioDeviceInfo {
    pub id: String,
    pub name: String,
    pub is_input: bool,
}

/// Enumerate native Windows WASAPI audio input and output devices directly from hardware
#[tauri::command]
pub fn get_audio_devices() -> Result<Vec<AudioDeviceInfo>, String> {
    let host = cpal::default_host();
    let mut result = Vec::new();

    if let Ok(inputs) = host.input_devices() {
        for d in inputs {
            if let Ok(name) = d.name() {
                if !result.iter().any(|existing: &AudioDeviceInfo| existing.name == name && existing.is_input) {
                    result.push(AudioDeviceInfo {
                        id: name.clone(),
                        name,
                        is_input: true,
                    });
                }
            }
        }
    }

    if let Ok(outputs) = host.output_devices() {
        for d in outputs {
            if let Ok(name) = d.name() {
                if !result.iter().any(|existing: &AudioDeviceInfo| existing.name == name && !existing.is_input) {
                    result.push(AudioDeviceInfo {
                        id: name.clone(),
                        name,
                        is_input: false,
                    });
                }
            }
        }
    }

    Ok(result)
}
