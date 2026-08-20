// AI commands — handles LLM calls, model routing, keyring storage, and SSE streaming

use serde::{Deserialize, Serialize};
use tauri::State;
use tauri::Emitter;
use futures_util::StreamExt;
use keyring::Entry;
use crate::state::{AppState, AIProvider, ContextItem, ContextKind};

const SERVICE_NAME: &str = "com.hackysack.app";

use std::fs;
use std::path::PathBuf;

fn get_fallback_config_path() -> PathBuf {
    let mut dir = if let Some(appdata) = std::env::var_os("APPDATA") {
        PathBuf::from(appdata)
    } else {
        std::env::temp_dir()
    };
    dir.push("HackySack");
    dir.push("store");
    let _ = fs::create_dir_all(&dir);
    dir
}

pub fn save_to_keyring(account: &str, secret: &str) {
    if let Ok(entry) = Entry::new(SERVICE_NAME, account) {
        if secret.trim().is_empty() {
            let _ = entry.delete_credential();
        } else {
            let _ = entry.set_password(secret);
        }
    }
    let path = get_fallback_config_path().join(format!("{}.txt", account));
    if secret.trim().is_empty() {
        let _ = fs::remove_file(path);
    } else {
        let _ = fs::write(path, secret.trim());
    }
}

pub fn get_from_keyring(account: &str) -> Option<String> {
    if let Ok(entry) = Entry::new(SERVICE_NAME, account) {
        if let Ok(pwd) = entry.get_password() {
            if !pwd.trim().is_empty() {
                return Some(pwd);
            }
        }
    }
    let path = get_fallback_config_path().join(format!("{}.txt", account));
    if let Ok(content) = fs::read_to_string(path) {
        let trimmed = content.trim().to_string();
        if !trimmed.is_empty() {
            return Some(trimmed);
        }
    }
    None
}

#[tauri::command]
pub fn save_secure_key(key_name: String, secret: String) -> Result<(), String> {
    save_to_keyring(&key_name, &secret);
    Ok(())
}

#[tauri::command]
pub fn get_secure_key(key_name: String) -> Result<Option<String>, String> {
    Ok(get_from_keyring(&key_name))
}

#[tauri::command]
pub fn delete_secure_key(key_name: String) -> Result<(), String> {
    save_to_keyring(&key_name, "");
    Ok(())
}

// Data transfer types shared with the frontend

#[allow(dead_code)]
#[derive(Debug, Serialize, Deserialize)]
pub struct AIRequest {
    pub prompt: String,
    pub context_items: Vec<ContextItem>, // The staged context buffer
    pub model: Option<String>,           // Which model to use (optional)
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct AIResponse {
    pub content: String,      // The AI's answer
    pub model_used: String,   // Which model actually responded
    pub tokens_used: u32,     // Rough usage tracking
    pub success: bool,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct ModelInfo {
    pub id: String,
    pub name: String,
    pub provider: String,
}

/// Non-streaming AI request — routes to the appropriate provider and returns a single response
#[tauri::command]
pub async fn ask_ai(
    state: State<'_, AppState>,
    prompt: String,
    context_items: Vec<ContextItem>,
    model: Option<String>,
) -> Result<AIResponse, String> {
    // Check if Cloud Mode ($14.99/mo managed SaaS) is enabled
    let use_cloud = {
        let guard = state.use_cloud_mode.lock().map_err(|e| e.to_string())?;
        *guard
    };

    if use_cloud {
        let jwt = {
            let j_guard = state.cloud_jwt.lock().map_err(|e| e.to_string())?;
            j_guard.clone().or_else(|| get_from_keyring("cloud_jwt"))
        };
        let endpoint = {
            let ep_guard = state.cloud_endpoint.lock().map_err(|e| e.to_string())?;
            get_from_keyring("cloud_endpoint").unwrap_or_else(|| ep_guard.clone())
        };

        if let Some(token) = jwt {
            if !token.trim().is_empty() {
                return call_cloud_proxy(&endpoint, &token, &prompt, &context_items, model).await;
            }
        }
        return Err("HackySack Cloud mode is enabled, but no authentication token was found. Please sign in or switch to BYOK mode.".to_string());
    }

    // Read state values and release locks before making async HTTP calls
    let api_key = {
        let key_guard = state.api_key.lock().map_err(|e| e.to_string())?;
        if key_guard.as_ref().map(|k| !k.trim().is_empty()).unwrap_or(false) {
            key_guard.clone()
        } else {
            get_from_keyring("ai_api_key")
        }
    };

    let provider = {
        let p = state.ai_provider.lock().map_err(|e| e.to_string())?;
        p.clone()
    };

    // Build a system prompt that includes all context items
    let context_text = build_context_text(&context_items);

    // If no API key is set, return a mock response for development
    if api_key.is_none() {
        return Ok(mock_ai_response(&prompt, &context_text));
    }

    let api_key = api_key.unwrap();

    // Safety check for model mismatch when switching providers
    let model = if let Some(m) = model {
        if matches!(provider, AIProvider::OpenRouter) && !m.contains('/') {
            Some("meta-llama/llama-3.1-8b-instruct".to_string())
        } else if matches!(provider, AIProvider::Groq) && m.contains('/') {
            Some("llama-3.3-70b-versatile".to_string())
        } else {
            Some(m)
        }
    } else {
        None
    };

    // Route to the correct AI provider
    match provider {
        AIProvider::OpenAI => call_openai(&api_key, &prompt, &context_text, &context_items, model).await,
        AIProvider::Anthropic => call_anthropic(&api_key, &prompt, &context_text, &context_items, model).await,
        AIProvider::Gemini => call_gemini(&api_key, &prompt, &context_text, &context_items, model).await,
        AIProvider::Groq => call_groq(&api_key, &prompt, &context_text, model).await,
        AIProvider::OpenRouter => call_openrouter(&api_key, &prompt, &context_text, model).await,
    }
}

/// Saves or updates the HackySack Cloud managed subscription configuration
#[tauri::command]
pub fn set_cloud_config(
    state: State<'_, AppState>,
    enabled: bool,
    jwt: Option<String>,
    endpoint: Option<String>,
) -> Result<(), String> {
    let mut mode_guard = state.use_cloud_mode.lock().map_err(|e| e.to_string())?;
    *mode_guard = enabled;
    save_to_keyring("cloud_mode", if enabled { "true" } else { "false" });

    let mut jwt_guard = state.cloud_jwt.lock().map_err(|e| e.to_string())?;
    if let Some(ref t) = jwt {
        if !t.trim().is_empty() {
            *jwt_guard = Some(t.clone());
            save_to_keyring("cloud_jwt", t);
        } else {
            *jwt_guard = None;
            save_to_keyring("cloud_jwt", "");
        }
    }

    let target_endpoint = match endpoint {
        Some(ref ep) if !ep.trim().is_empty() && !ep.contains("your-supabase-project") => ep.clone(),
        _ => "https://vzuutupafqjrmfuncgxl.supabase.co/functions/v1/ai-proxy".to_string(),
    };

    let mut ep_guard = state.cloud_endpoint.lock().map_err(|e| e.to_string())?;
    *ep_guard = target_endpoint.clone();
    save_to_keyring("cloud_endpoint", &target_endpoint);

    Ok(())
}

/// Acknowledges cloud activation modal display and resets the just_activated flag
#[tauri::command]
pub fn acknowledge_activation(state: State<'_, AppState>) -> Result<(), String> {
    if let Ok(mut guard) = state.just_activated.lock() {
        *guard = false;
    }
    Ok(())
}

/// Returns current HackySack Cloud managed subscription status
#[tauri::command]
pub fn get_cloud_config(state: State<'_, AppState>) -> Result<serde_json::Value, String> {
    let enabled = {
        let guard = state.use_cloud_mode.lock().map_err(|e| e.to_string())?;
        *guard
    };
    let jwt = {
        let guard = state.cloud_jwt.lock().map_err(|e| e.to_string())?;
        guard.clone()
    };
    let has_token = jwt.as_ref().map(|t| !t.trim().is_empty()).unwrap_or(false);

    let endpoint = {
        let guard = state.cloud_endpoint.lock().map_err(|e| e.to_string())?;
        if guard.contains("your-supabase-project") || guard.trim().is_empty() {
            "https://vzuutupafqjrmfuncgxl.supabase.co/functions/v1/ai-proxy".to_string()
        } else {
            guard.clone()
        }
    };

    let just_activated = {
        if let Ok(guard) = state.just_activated.lock() {
            *guard
        } else {
            false
        }
    };

    Ok(serde_json::json!({
        "enabled": enabled && has_token,
        "hasToken": has_token,
        "jwt": jwt,
        "endpoint": endpoint,
        "justActivated": just_activated
    }))
}

async fn call_cloud_proxy_stream(
    app: &tauri::AppHandle,
    endpoint: &str,
    jwt: &str,
    prompt: &str,
    context_items: &[ContextItem],
    model: Option<String>,
) -> Result<(), String> {
    println!("[CLOUD PROXY STREAM] Endpoint: {}, Requested Model: {:?}", endpoint, model);
    let context_text = build_context_text(context_items);
    let system_prompt = build_system_prompt(&context_text);

    let effective_prompt = if !context_text.is_empty() && !prompt.contains("=== CANDIDATE RESUME") {
        format!("{}\n\n=== CANDIDATE RESUME & TARGET JOB DESCRIPTION ===\n{}", prompt, context_text)
    } else {
        prompt.to_string()
    };

    let client = reqwest::Client::new();
    let body = serde_json::json!({
        "prompt": effective_prompt,
        "context_items": context_items,
        "context_text": context_text,
        "system_prompt": system_prompt,
        "model": model,
        "stream": true,
    });

    let response = client
        .post(endpoint)
        .header("Authorization", format!("Bearer {}", jwt))
        .header("Content-Type", "application/json")
        .header("Accept", "text/event-stream")
        .header("Cache-Control", "no-cache")
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("Cloud Proxy stream request failed: {}", e))?;

    if !response.status().is_success() {
        let err_text = response.text().await.unwrap_or_default();
        return Err(format!("Cloud Proxy streaming error: {}", err_text));
    }

    use futures_util::StreamExt;
    let mut stream = response.bytes_stream();
    let mut buffer = String::new();

    while let Some(chunk_res) = stream.next().await {
        if let Ok(chunk) = chunk_res {
            let text = String::from_utf8_lossy(&chunk);
            buffer.push_str(&text);

            while let Some(pos) = buffer.find('\n') {
                let line = buffer[..pos].trim().to_string();
                buffer = buffer[pos + 1..].to_string();

                if let Some(rest) = line.strip_prefix("data:") {
                    let data_str = rest.trim();
                    if data_str == "[DONE]" {
                        let _ = app.emit("ai_stream_done", "");
                        return Ok(());
                    }
                    if let Ok(parsed) = serde_json::from_str::<serde_json::Value>(data_str) {
                        if let Some(token) = parsed["choices"][0]["delta"]["content"].as_str() {
                            let _ = app.emit("ai_stream_chunk", token);
                        } else if let Some(token) = parsed["choices"][0]["text"].as_str() {
                            let _ = app.emit("ai_stream_chunk", token);
                        }
                    }
                }
            }
        }
    }

    let remaining = buffer.trim();
    if let Some(rest) = remaining.strip_prefix("data:") {
        let data_str = rest.trim();
        if data_str != "[DONE]" {
            if let Ok(parsed) = serde_json::from_str::<serde_json::Value>(data_str) {
                if let Some(token) = parsed["choices"][0]["delta"]["content"].as_str() {
                    let _ = app.emit("ai_stream_chunk", token);
                } else if let Some(token) = parsed["choices"][0]["text"].as_str() {
                    let _ = app.emit("ai_stream_chunk", token);
                }
            }
        }
    }

    let _ = app.emit("ai_stream_done", "");
    Ok(())
}

async fn call_cloud_proxy(
    endpoint: &str,
    jwt: &str,
    prompt: &str,
    context_items: &[ContextItem],
    model: Option<String>,
) -> Result<AIResponse, String> {
    let client = reqwest::Client::new();

    // Handle status ping request directly to the ai-proxy endpoint
    if prompt == "__status__" {
        let body = serde_json::json!({
            "action": "status",
            "prompt": "__status__"
        });
        if let Ok(res) = client.post(endpoint)
            .header("Authorization", format!("Bearer {}", jwt))
            .header("Content-Type", "application/json")
            .json(&body)
            .send().await {
            if res.status().is_success() {
                let status_text = res.text().await.unwrap_or_default();
                return Ok(AIResponse {
                    content: status_text,
                    model_used: "cloud-status".to_string(),
                    tokens_used: 0,
                    success: true,
                });
            } else {
                let err_text = res.text().await.unwrap_or_default();
                return Err(format!("Subscription inactive: {}", err_text));
            }
        }
    }

    let context_text = build_context_text(context_items);
    let system_prompt = build_system_prompt(&context_text);

    let effective_prompt = if !context_text.is_empty() && !prompt.contains("=== CANDIDATE RESUME") {
        format!("{}\n\n=== CANDIDATE RESUME & TARGET JOB DESCRIPTION ===\n{}", prompt, context_text)
    } else {
        prompt.to_string()
    };

    let body = serde_json::json!({
        "prompt": effective_prompt,
        "context_items": context_items,
        "context_text": context_text,
        "system_prompt": system_prompt,
        "model": model,
        "stream": false,
    });

    let response = client
        .post(endpoint)
        .header("Authorization", format!("Bearer {}", jwt))
        .header("Content-Type", "application/json")
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("Cloud Proxy request failed: {}", e))?;

    if !response.status().is_success() {
        let err_text = response.text().await.unwrap_or_default();
        return Err(format!("Cloud Proxy error: {}", err_text));
    }

    let json: serde_json::Value = response
        .json()
        .await
        .map_err(|e| format!("Failed to parse Cloud Proxy response: {}", e))?;

    let content = if json.get("standard_limit").is_some() || json.get("status").is_some() {
        json.to_string()
    } else {
        json["content"]
            .as_str()
            .or_else(|| json["choices"][0]["message"]["content"].as_str())
            .unwrap_or("No response content")
            .to_string()
    };

    let model_used = json["model_used"]
        .as_str()
        .or_else(|| json["model"].as_str())
        .unwrap_or("hackysack-cloud-model")
        .to_string();

    let tokens_used = json["tokens_used"]
        .as_u64()
        .or_else(|| json["usage"]["total_tokens"].as_u64())
        .unwrap_or(0) as u32;

    Ok(AIResponse {
        content,
        model_used,
        tokens_used,
        success: true,
    })
}

/// Saves the API key, transcription key, and provider selection into app state + keyring
#[tauri::command]
pub fn set_api_key(
    state: State<'_, AppState>,
    key: String,
    provider: String,
    transcription_key: Option<String>,
) -> Result<(), String> {
    // When setting a BYOK key, disable Cloud Mode so local keys take effect immediately
    if let Ok(mut mode_guard) = state.use_cloud_mode.lock() {
        *mode_guard = false;
        save_to_keyring("cloud_mode", "false");
    }

    // Set the main API key
    let mut key_guard = state.api_key.lock().map_err(|e| e.to_string())?;
    *key_guard = Some(key.clone());
    save_to_keyring("ai_api_key", &key);
    drop(key_guard);

    // Set the transcription API key if provided
    let mut trans_key_guard = state.transcription_api_key.lock().map_err(|e| e.to_string())?;
    if let Some(ref t_key) = transcription_key {
        *trans_key_guard = Some(t_key.clone());
        save_to_keyring("transcription_api_key", t_key);
    }
    drop(trans_key_guard);

    // Set the provider
    let mut provider_guard = state.ai_provider.lock().map_err(|e| e.to_string())?;
    *provider_guard = match provider.as_str() {
        "openai"     => AIProvider::OpenAI,
        "anthropic"  => AIProvider::Anthropic,
        "gemini"     => AIProvider::Gemini,
        "groq"       => AIProvider::Groq,
        "openrouter" => AIProvider::OpenRouter,
        _ => return Err(format!("Unknown provider: {}", provider)),
    };

    Ok(())
}

/// Returns the full catalog of supported models across all providers (or curated models in Cloud Mode)
#[tauri::command]
pub fn get_available_models(state: State<'_, AppState>) -> Result<Vec<ModelInfo>, String> {
    let is_cloud = {
        let mode_guard = state.use_cloud_mode.lock().map_err(|e| e.to_string())?;
        *mode_guard
    };

    if is_cloud {
        return Ok(vec![
            // Standard Models (300 Daily Allowance Included)
            ModelInfo { id: "google/gemini-2.5-flash".into(), name: "Gemini 3.7 Flash".into(), provider: "Standard".into() },
            ModelInfo { id: "google/gemini-2.0-flash-001".into(), name: "Gemini 2.0 Flash".into(), provider: "Standard".into() },
            ModelInfo { id: "openai/gpt-4o-mini".into(), name: "GPT-4o Mini".into(), provider: "Standard".into() },
            ModelInfo { id: "deepseek/deepseek-chat".into(), name: "DeepSeek V3".into(), provider: "Standard".into() },
            ModelInfo { id: "meta-llama/llama-3.3-70b-instruct".into(), name: "Llama 3.3 70B".into(), provider: "Standard".into() },
            ModelInfo { id: "qwen/qwen-2.5-coder-32b-instruct".into(), name: "Qwen 2.5 Coder 32B".into(), provider: "Standard".into() },

            // Premium Models (150 Daily Premium Credits)
            ModelInfo { id: "google/gemini-2.5-pro".into(), name: "Google Pro 3.1 ✦ (Cost: 1 Credit)".into(), provider: "Premium".into() },
            ModelInfo { id: "anthropic/claude-3.7-sonnet".into(), name: "Claude 3.7 Sonnet ✦ (Cost: 2 Credits)".into(), provider: "Premium".into() },
            ModelInfo { id: "anthropic/claude-3.7-sonnet:thinking".into(), name: "Claude 3.7 Sonnet (Thinking) ✦ (Cost: 2 Credits)".into(), provider: "Premium".into() },
            ModelInfo { id: "anthropic/claude-3.5-sonnet".into(), name: "Claude 3.5 Sonnet ✦ (Cost: 2 Credits)".into(), provider: "Premium".into() },
            ModelInfo { id: "deepseek/deepseek-r1".into(), name: "DeepSeek R1 Reasoning ✦ (Cost: 1 Credit)".into(), provider: "Premium".into() },
            ModelInfo { id: "openai/gpt-4.5-preview".into(), name: "GPT-4.5 Preview ✦ (Cost: 3 Credits)".into(), provider: "Premium".into() },
            ModelInfo { id: "openai/o3-mini".into(), name: "OpenAI o3-mini ✦ (Cost: 1 Credit)".into(), provider: "Premium".into() },
            ModelInfo { id: "openai/gpt-4o".into(), name: "OpenAI GPT-4o ✦ (Cost: 2 Credits)".into(), provider: "Premium".into() },
            ModelInfo { id: "openai/o1".into(), name: "OpenAI o1 Deep Reasoning ✦ (Cost: 3 Credits)".into(), provider: "Premium".into() },
            ModelInfo { id: "anthropic/claude-3-opus".into(), name: "Claude 3.0 Opus ✦ (Cost: 3 Credits)".into(), provider: "Premium".into() },
            ModelInfo { id: "x-ai/grok-2-1212".into(), name: "Grok 2 ✦ (Cost: 1 Credit)".into(), provider: "Premium".into() },
        ]);
    }

    Ok(vec![
        // Native OpenAI Direct
        ModelInfo { id: "gpt-4.5-preview".into(), name: "GPT-4.5 Preview".into(), provider: "OpenAI".into() },
        ModelInfo { id: "o3-mini".into(), name: "OpenAI o3-mini".into(), provider: "OpenAI".into() },
        ModelInfo { id: "o1".into(), name: "OpenAI o1".into(), provider: "OpenAI".into() },
        ModelInfo { id: "gpt-4o".into(), name: "GPT-4o".into(), provider: "OpenAI".into() },
        ModelInfo { id: "gpt-4o-mini".into(), name: "GPT-4o Mini".into(), provider: "OpenAI".into() },

        // Native Anthropic Direct
        ModelInfo { id: "claude-3-7-sonnet-20250219".into(), name: "Claude 3.7 Sonnet".into(), provider: "Anthropic".into() },
        ModelInfo { id: "claude-3-5-sonnet-20241022".into(), name: "Claude 3.5 Sonnet".into(), provider: "Anthropic".into() },
        ModelInfo { id: "claude-3-5-haiku-20241022".into(), name: "Claude 3.5 Haiku".into(), provider: "Anthropic".into() },
        ModelInfo { id: "claude-3-opus-20240229".into(), name: "Claude 3.0 Opus".into(), provider: "Anthropic".into() },

        // Native Google Gemini Direct
        ModelInfo { id: "gemini-2.5-flash".into(), name: "Gemini 3.7 Flash".into(), provider: "Gemini".into() },
        ModelInfo { id: "gemini-2.5-pro".into(), name: "Google Pro 3.1".into(), provider: "Gemini".into() },
        ModelInfo { id: "gemini-2.0-flash".into(), name: "Gemini 2.0 Flash".into(), provider: "Gemini".into() },
        ModelInfo { id: "gemini-2.0-flash-thinking-exp-01-21".into(), name: "Gemini 2.0 Flash Thinking".into(), provider: "Gemini".into() },
        ModelInfo { id: "gemini-1.5-pro".into(), name: "Gemini 1.5 Pro".into(), provider: "Gemini".into() },
        ModelInfo { id: "gemini-1.5-flash".into(), name: "Gemini 1.5 Flash".into(), provider: "Gemini".into() },

        // Native Groq Direct
        ModelInfo { id: "llama-3.3-70b-versatile".into(), name: "Llama 3.3 70B (Groq)".into(), provider: "Groq".into() },
        ModelInfo { id: "llama-3.1-8b-instant".into(), name: "Llama 3.1 8B (Groq)".into(), provider: "Groq".into() },
        ModelInfo { id: "deepseek-r1-distill-llama-70b".into(), name: "DeepSeek R1 Distill 70B (Groq)".into(), provider: "Groq".into() },

        // OpenRouter (Multi-Provider Catalog)
        ModelInfo { id: "anthropic/claude-3.7-sonnet".into(), name: "Claude 3.7 Sonnet".into(), provider: "OpenRouter".into() },
        ModelInfo { id: "anthropic/claude-3.7-sonnet:thinking".into(), name: "Claude 3.7 Sonnet (Thinking)".into(), provider: "OpenRouter".into() },
        ModelInfo { id: "anthropic/claude-3.5-sonnet".into(), name: "Claude 3.5 Sonnet".into(), provider: "OpenRouter".into() },
        ModelInfo { id: "google/gemini-2.5-flash".into(), name: "Gemini 3.7 Flash".into(), provider: "OpenRouter".into() },
        ModelInfo { id: "google/gemini-2.5-pro".into(), name: "Google Pro 3.1".into(), provider: "OpenRouter".into() },
        ModelInfo { id: "google/gemini-2.0-flash-001".into(), name: "Gemini 2.0 Flash".into(), provider: "OpenRouter".into() },
        ModelInfo { id: "deepseek/deepseek-r1".into(), name: "DeepSeek R1 Reasoning".into(), provider: "OpenRouter".into() },
        ModelInfo { id: "deepseek/deepseek-chat".into(), name: "DeepSeek V3".into(), provider: "OpenRouter".into() },
        ModelInfo { id: "openai/gpt-4.5-preview".into(), name: "GPT-4.5 Preview".into(), provider: "OpenRouter".into() },
        ModelInfo { id: "openai/o3-mini".into(), name: "OpenAI o3-mini".into(), provider: "OpenRouter".into() },
        ModelInfo { id: "openai/o1".into(), name: "OpenAI o1".into(), provider: "OpenRouter".into() },
        ModelInfo { id: "openai/gpt-4o".into(), name: "GPT-4o".into(), provider: "OpenRouter".into() },
        ModelInfo { id: "openai/gpt-4o-mini".into(), name: "GPT-4o Mini".into(), provider: "OpenRouter".into() },
        ModelInfo { id: "meta-llama/llama-3.3-70b-instruct".into(), name: "Llama 3.3 70B".into(), provider: "OpenRouter".into() },
        ModelInfo { id: "qwen/qwen-2.5-coder-32b-instruct".into(), name: "Qwen 2.5 Coder 32B".into(), provider: "OpenRouter".into() },
        ModelInfo { id: "x-ai/grok-2-1212".into(), name: "Grok 2".into(), provider: "OpenRouter".into() },
    ])
}

// Helper functions

fn extract_images_from_context(items: &[ContextItem]) -> Vec<String> {
    items
        .iter()
        .filter_map(|it| {
            if it.content.starts_with("data:image/") {
                Some(it.content.clone())
            } else {
                None
            }
        })
        .collect()
}

fn build_user_message_content(prompt: &str, items: &[ContextItem]) -> serde_json::Value {
    let images = extract_images_from_context(items);
    if images.is_empty() {
        serde_json::Value::String(prompt.to_string())
    } else {
        let mut content_arr = vec![
            serde_json::json!({
                "type": "text",
                "text": prompt
            })
        ];
        for img in images {
            content_arr.push(serde_json::json!({
                "type": "image_url",
                "image_url": {
                    "url": img
                }
            }));
        }
        serde_json::Value::Array(content_arr)
    }
}

fn build_context_text(items: &[ContextItem]) -> String {
    if items.is_empty() {
        return String::new();
    }

    let mut docs = Vec::new();
    let mut history = Vec::new();

    for item in items {
        let (label, max_chars) = match item.kind {
            ContextKind::Document   => ("📄 Document / Profile", 5000),
            ContextKind::Audio      => ("🎤 Live Discussion Dialogue", 3000),
            ContextKind::Screenshot => ("📸 Screenshot Content", 2000),
            ContextKind::Text       => ("📋 Pasted Text / Notes", 3000),
        };

        let content = if item.content.starts_with("data:image/") {
            "[📸 Active Screen Snapshot attached as image input]".to_string()
        } else if item.content.chars().count() > max_chars {
            let truncated: String = item.content.chars().take(max_chars).collect();
            format!("{}\n[... truncated for prompt length ...]", truncated)
        } else {
            item.content.clone()
        };

        let formatted = format!("[{}]\n{}", label, content);
        if item.kind == ContextKind::Document {
            docs.push(formatted);
        } else {
            history.push(formatted);
        }
    }

    let doc_text = docs.join("\n\n---\n\n");
    let mut history_parts = Vec::new();
    let mut current_len = doc_text.chars().count();

    // Prioritize the MOST RECENT conversation items (reverse iteration)
    for h in history.into_iter().rev() {
        let h_len = h.chars().count();
        if current_len + h_len + 5 > 15000 {
            break; // Stop taking older history items when 15k character cap is reached
        }
        current_len += h_len + 5;
        history_parts.push(h);
    }
    history_parts.reverse(); // Restore chronological order for recent history

    let mut all_parts = Vec::new();
    if !doc_text.is_empty() {
        all_parts.push(doc_text);
    }
    all_parts.extend(history_parts);

    all_parts.join("\n\n---\n\n")
}

fn mock_ai_response(prompt: &str, context: &str) -> AIResponse {
    let mock_content = if context.is_empty() {
        format!(
            "**[MOCK — No API Key Set]**\n\nYou asked: \"{}\"\n\n\
            This is a placeholder response. Add your API key in Settings to get real AI responses.\n\n\
            **Sample Answer:** I would approach this by breaking the problem into smaller pieces, \
            identifying edge cases, and explaining my thought process clearly.",
            prompt
        )
    } else {
        format!(
            "**[MOCK — No API Key Set]**\n\nI can see your context ({} item(s)) and question: \"{}\"\n\n\
            With a real API key, I'd combine all your context to give a tailored answer.",
            context.lines().filter(|l| l.contains("[")).count(),
            prompt
        )
    };

    AIResponse {
        content: mock_content,
        model_used: "mock-model".to_string(),
        tokens_used: 0,
        success: true,
    }
}

// Provider-specific API call implementations

async fn call_openai(
    api_key: &str,
    prompt: &str,
    context: &str,
    context_items: &[ContextItem],
    model: Option<String>,
) -> Result<AIResponse, String> {
    let client = reqwest::Client::new();
    let model_id = model.unwrap_or_else(|| "gpt-4o".to_string());

    let system_prompt = build_system_prompt(context);
    let user_content = build_user_message_content(prompt, context_items);

    let body = serde_json::json!({
        "model": model_id,
        "messages": [
            { "role": "system", "content": system_prompt },
            { "role": "user", "content": user_content }
        ],
        "max_tokens": 1500,
        "temperature": 0.7
    });

    let response = client
        .post("https://api.openai.com/v1/chat/completions")
        .header("Authorization", format!("Bearer {}", api_key))
        .header("Content-Type", "application/json")
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("OpenAI request failed: {}", e))?;

    if !response.status().is_success() {
        let err_text = response.text().await.unwrap_or_default();
        return Err(format!("OpenAI API error: {}", err_text));
    }

    let json: serde_json::Value = response
        .json()
        .await
        .map_err(|e| format!("Failed to parse OpenAI response: {}", e))?;

    // Navigate the JSON response
    let content = json["choices"][0]["message"]["content"]
        .as_str()
        .unwrap_or("No response content")
        .to_string();

    let tokens = json["usage"]["total_tokens"]
        .as_u64()
        .unwrap_or(0) as u32;

    Ok(AIResponse {
        content,
        model_used: model_id,
        tokens_used: tokens,
        success: true,
    })
}

async fn call_groq(
    api_key: &str,
    prompt: &str,
    context: &str,
    model: Option<String>,
) -> Result<AIResponse, String> {
    let client = reqwest::Client::new();
    let original_model = model.unwrap_or_else(|| "llama-3.3-70b-versatile".to_string());

    // If using the default large model, set up fallbacks. Otherwise just try the requested one.
    let models_to_try = if original_model == "llama-3.3-70b-versatile" {
        vec!["llama-3.3-70b-versatile", "llama-3.1-8b-instant", "mixtral-8x7b-32768"]
    } else {
        vec![original_model.as_str()]
    };

    let mut last_err = String::new();

    for model_id in models_to_try {
        let system_prompt = build_system_prompt(context);

        let body = serde_json::json!({
            "model": model_id,
            "messages": [
                { "role": "system", "content": system_prompt },
                { "role": "user", "content": prompt }
            ],
            "max_tokens": 1500,
            "temperature": 0.7
        });

        let response = client
            .post("https://api.groq.com/openai/v1/chat/completions")
            .header("Authorization", format!("Bearer {}", api_key))
            .header("Content-Type", "application/json")
            .json(&body)
            .send()
            .await
            .map_err(|e| format!("Groq request failed: {}", e))?;

        if response.status().is_success() {
            let json: serde_json::Value = response
                .json()
                .await
                .map_err(|e| format!("Failed to parse Groq response: {}", e))?;

            let content = json["choices"][0]["message"]["content"]
                .as_str()
                .unwrap_or("No response content")
                .to_string();

            let tokens = json["usage"]["total_tokens"]
                .as_u64()
                .unwrap_or(0) as u32;

            return Ok(AIResponse {
                content,
                model_used: model_id.to_string(),
                tokens_used: tokens,
                success: true,
            });
        }

        let status = response.status();
        let err_text = response.text().await.unwrap_or_default();
        last_err = format!("Groq API error (HTTP {}): {}", status.as_u16(), err_text);

        // If it's a 429 Too Many Requests, try the next fallback model. Otherwise abort.
        if status.as_u16() != 429 {
            break;
        }
        
        println!("Hit 429 rate limit on Groq for {}, falling back to next model...", model_id);
    }

    Err(last_err)
}

async fn call_anthropic(
    api_key: &str,
    prompt: &str,
    context: &str,
    context_items: &[ContextItem],
    model: Option<String>,
) -> Result<AIResponse, String> {
    let client = reqwest::Client::new();
    let model_id = model.unwrap_or_else(|| "claude-3-7-sonnet-20250219".to_string());
    let system_prompt = build_system_prompt(context);
    let images = extract_images_from_context(context_items);

    let user_content = if images.is_empty() {
        serde_json::json!(prompt)
    } else {
        let mut parts = vec![serde_json::json!({ "type": "text", "text": prompt })];
        for img in images {
            if let Some(base64_part) = img.strip_prefix("data:image/png;base64,") {
                parts.push(serde_json::json!({
                    "type": "image",
                    "source": {
                        "type": "base64",
                        "media_type": "image/png",
                        "data": base64_part
                    }
                }));
            } else if let Some(base64_part) = img.strip_prefix("data:image/jpeg;base64,") {
                parts.push(serde_json::json!({
                    "type": "image",
                    "source": {
                        "type": "base64",
                        "media_type": "image/jpeg",
                        "data": base64_part
                    }
                }));
            }
        }
        serde_json::json!(parts)
    };

    let body = serde_json::json!({
        "model": model_id,
        "max_tokens": 1500,
        "system": system_prompt,
        "messages": [
            { "role": "user", "content": user_content }
        ]
    });

    let response = client
        .post("https://api.anthropic.com/v1/messages")
        .header("x-api-key", api_key)
        .header("anthropic-version", "2023-06-01")
        .header("Content-Type", "application/json")
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("Anthropic request failed: {}", e))?;

    if !response.status().is_success() {
        let err_text = response.text().await.unwrap_or_default();
        return Err(format!("Anthropic API error: {}", err_text));
    }

    let json: serde_json::Value = response
        .json()
        .await
        .map_err(|e| format!("Failed to parse Anthropic response: {}", e))?;

    let content = json["content"][0]["text"]
        .as_str()
        .unwrap_or("No response content")
        .to_string();

    let tokens = json["usage"]["output_tokens"]
        .as_u64()
        .unwrap_or(0) as u32;

    Ok(AIResponse {
        content,
        model_used: model_id,
        tokens_used: tokens,
        success: true,
    })
}

async fn call_gemini(
    api_key: &str,
    prompt: &str,
    context: &str,
    context_items: &[ContextItem],
    model: Option<String>,
) -> Result<AIResponse, String> {
    let client = reqwest::Client::new();
    let model_id = model.unwrap_or_else(|| "gemini-2.0-flash".to_string());
    let system_prompt = build_system_prompt(context);
    let full_prompt = format!("{}\n\nQuestion: {}", system_prompt, prompt);
    let images = extract_images_from_context(context_items);

    let mut parts = vec![serde_json::json!({ "text": full_prompt })];
    for img in images {
        if let Some(base64_part) = img.strip_prefix("data:image/png;base64,") {
            parts.push(serde_json::json!({
                "inline_data": {
                    "mime_type": "image/png",
                    "data": base64_part
                }
            }));
        } else if let Some(base64_part) = img.strip_prefix("data:image/jpeg;base64,") {
            parts.push(serde_json::json!({
                "inline_data": {
                    "mime_type": "image/jpeg",
                    "data": base64_part
                }
            }));
        }
    }

    let url = format!(
        "https://generativelanguage.googleapis.com/v1beta/models/{}:generateContent?key={}",
        model_id, api_key
    );

    let body = serde_json::json!({
        "contents": [
            { "parts": parts }
        ]
    });

    let response = client
        .post(&url)
        .header("Content-Type", "application/json")
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("Gemini request failed: {}", e))?;

    if !response.status().is_success() {
        let err_text = response.text().await.unwrap_or_default();
        return Err(format!("Gemini API error: {}", err_text));
    }

    let json: serde_json::Value = response
        .json()
        .await
        .map_err(|e| format!("Failed to parse Gemini response: {}", e))?;

    let content = json["candidates"][0]["content"]["parts"][0]["text"]
        .as_str()
        .unwrap_or("No response content")
        .to_string();

    Ok(AIResponse {
        content,
        model_used: model_id,
        tokens_used: 0,
        success: true,
    })
}

fn build_system_prompt(context: &str) -> String {
    let base = "You are HackySack Teleprompter — an expert real-time live job interview assistant.\n\
                YOU ARE ASSISTING A CANDIDATE IN AN ACTIVE, DYNAMIC INTERVIEW DISCUSSION.\n\
                \n\
                CORE CONVERSATIONAL DIRECTIVES:\n\
                1. CONVERSATION CONTINUITY & CONTEXT AWARENESS: You have access to the live discussion dialogue transcript, candidate resume, target job description, and prior Q&A exchanges. The interviewer may ask follow-up questions, drill into specific technologies/metrics mentioned earlier, challenge assumptions, or pivot to system design/coding. You MUST understand pronouns ('that', 'it', 'the database you picked') and contextual references by actively synthesizing the conversation history.\n\
                2. CANDIDATE RESUME & AUTHENTICITY: Seamlessly ground answers in the candidate's actual projects, technologies, and achievements from their resume so the candidate sounds 100% authentic.\n\
                3. CONSISTENCY: Never contradict statements, architectures, or choices you/the candidate made in earlier turns of this session.\n\
                4. VISUAL REASONING: If screen screenshots are provided, analyze the problem, code, or architecture diagram thoroughly and provide exact, working code solutions.\n\
                5. INSTANT EYE-GLANCING & HIGH SPEED: Output clean markdown structured for 0.5-second eye-glancing during a live video call. Keep headers minimal and professional. Keep answers punchy, articulate, and direct.\n\
                6. DYNAMIC SMART CODE RULE: If the discussion or question asks about or involves writing code, SQL queries, algorithms, functions, data structures, scripts, or technical implementations in ANY programming language or query dialect (SQL, Python, TypeScript, JavaScript, Java, C++, Go, Rust, Bash, React, etc.), you MUST include a clean, copy-pasteable markdown code block with a working illustrative example snippet. Never pigeonhole into one language; match whatever tech or language is requested. For behavioral, situational, personal, or non-coding questions, NEVER output code blocks.\n\
                7. CRITICAL: NO conversational preamble (e.g. 'Sure!', 'Great question', 'Certainly'). Start IMMEDIATELY with the first section header.\n\
                8. Write in 1st person ('I', 'my') as an expert candidate.";

    if context.is_empty() {
        base.to_string()
    } else {
        format!("{}\n\n=== CANDIDATE PROFILE, JOB CONTEXT & CONVERSATION TRANSCRIPT ===\n{}", base, context)
    }
}

/// Streaming AI request — emits SSE token chunks via Tauri events
#[tauri::command]
pub async fn ask_ai_stream(
    state: State<'_, AppState>,
    app: tauri::AppHandle,
    prompt: String,
    context_items: Vec<ContextItem>,
    model: Option<String>,
) -> Result<(), String> {
    let use_cloud = {
        let guard = state.use_cloud_mode.lock().map_err(|e| e.to_string())?;
        *guard
    };

    if use_cloud {
        let jwt = {
            let j_guard = state.cloud_jwt.lock().map_err(|e| e.to_string())?;
            j_guard.clone()
        };
        let endpoint = {
            let ep_guard = state.cloud_endpoint.lock().map_err(|e| e.to_string())?;
            ep_guard.clone()
        };

        if let Some(token) = jwt {
            if !token.trim().is_empty() {
                if let Err(e) = call_cloud_proxy_stream(&app, &endpoint, &token, &prompt, &context_items, model.clone()).await {
                    eprintln!("Cloud streaming fallback to non-streamed: {}", e);
                    let res = call_cloud_proxy(&endpoint, &token, &prompt, &context_items, model).await?;
                    let _ = app.emit("ai_stream_chunk", &res.content);
                    let _ = app.emit("ai_stream_done", "");
                }
                return Ok(());
            }
        }
        return Err("HackySack Cloud mode is enabled, but no authentication token was found. Please sign in.".to_string());
    }

    let api_key = {
        let k = state.api_key.lock().map_err(|e| e.to_string())?;
        k.clone()
    };
    let provider = {
        let p = state.ai_provider.lock().map_err(|e| e.to_string())?;
        p.clone()
    };

    let api_key = match api_key {
        Some(k) => k,
        None => {
            // If no API key is set, emit mock response tokens as a stream
            let context_text = build_context_text(&context_items);
            let mock = mock_ai_response(&prompt, &context_text);
            let _ = app.emit("ai_stream_chunk", &mock.content);
            let _ = app.emit("ai_stream_done", "");
            return Ok(());
        }
    };

    let raw_model_id = model.clone().unwrap_or_else(|| "llama-3.3-70b-versatile".to_string());
    let is_openrouter = provider == AIProvider::OpenRouter || raw_model_id.contains('/');

    // OpenRouter, Groq, and OpenAI streaming are supported (OpenAI-compatible SSE format)
    if !is_openrouter && !matches!(provider, AIProvider::Groq | AIProvider::OpenAI) {
        // Fall back to non-streaming for other native direct providers (Anthropic, Gemini)
        let context_text = build_context_text(&context_items);
        let result = match provider {
            AIProvider::Anthropic => call_anthropic(&api_key, &prompt, &context_text, &context_items, model).await,
            AIProvider::Gemini    => call_gemini(&api_key, &prompt, &context_text, &context_items, model).await,
            _ => unreachable!(),
        };

        match result {
            Ok(resp) => {
                let _ = app.emit("ai_stream_chunk", &resp.content);
            }
            Err(e) => {
                let err_msg = format!("⚠️ API Error: {}", e);
                let _ = app.emit("ai_stream_chunk", &err_msg);
            }
        }
        let _ = app.emit("ai_stream_done", "");
        return Ok(());
    }

fn normalize_model_for_openrouter(model_id: &str) -> String {
    if model_id.contains('/') || model_id.starts_with('~') {
        return match model_id {
            "anthropic/claude-3.7-sonnet" | "anthropic/claude-3.7-sonnet:thinking" | "anthropic/claude-3.5-sonnet" | "anthropic/claude-sonnet-4.5" | "anthropic/claude-sonnet-5" => "~anthropic/claude-sonnet-latest".to_string(),
            "anthropic/claude-3-opus" | "anthropic/claude-opus-4" | "anthropic/claude-opus-5" => "~anthropic/claude-opus-latest".to_string(),
            "anthropic/claude-3-haiku" | "anthropic/claude-3.5-haiku" => "~anthropic/claude-haiku-latest".to_string(),
            "google/gemini-2.5-pro" | "google/gemini-1.5-pro" => "google/gemini-2.5-pro".to_string(),
            "google/gemini-2.5-flash" => "google/gemini-2.5-flash".to_string(),
            "google/gemini-2.0-flash-001" | "google/gemini-2.0-flash" => "google/gemini-2.0-flash-001".to_string(),
            "deepseek/deepseek-chat" => "deepseek/deepseek-chat".to_string(),
            "deepseek/deepseek-r1" => "deepseek/deepseek-r1".to_string(),
            "qwen/qwen-2.5-coder-32b-instruct" | "qwen/qwen-2.5-coder" => "qwen/qwen3-coder".to_string(),
            "meta-llama/llama-3.3-70b-instruct" => "meta-llama/llama-3.3-70b-instruct".to_string(),
            "x-ai/grok-2-1212" | "x-ai/grok-2" => "x-ai/grok-4.20".to_string(),
            _ => model_id.to_string(),
        };
    }
    match model_id {
        "claude-3-7-sonnet-20250219" | "claude-3-7-sonnet" | "claude-3-5-sonnet-20241022" | "claude-3-5-sonnet" => "~anthropic/claude-sonnet-latest".to_string(),
        "claude-3-5-haiku-20241022"  | "claude-3-5-haiku"                                                        => "~anthropic/claude-haiku-latest".to_string(),
        "claude-3-opus-20240229"    | "claude-3-opus"                                                           => "~anthropic/claude-opus-latest".to_string(),
        "gpt-4o"                                          => "openai/gpt-4o".to_string(),
        "gpt-4o-mini"                                     => "openai/gpt-4o-mini".to_string(),
        "gpt-4.5-preview"                                 => "openai/gpt-4.5-preview".to_string(),
        "o1"                                              => "openai/o1".to_string(),
        "o3-mini"                                         => "openai/o3-mini".to_string(),
        "gemini-2.5-flash"                                => "google/gemini-2.5-flash".to_string(),
        "gemini-2.0-flash"                                => "google/gemini-2.0-flash-001".to_string(),
        "gemini-1.5-pro"                                  => "google/gemini-2.5-pro".to_string(),
        "llama-3.3-70b-versatile"                         => "meta-llama/llama-3.3-70b-instruct".to_string(),
        "llama-3.1-8b-instant"                            => "meta-llama/llama-3.1-8b-instruct".to_string(),
        _ => format!("openai/{}", model_id),
    }
}

    let context_text = build_context_text(&context_items);
    let system_prompt = build_system_prompt(&context_text);
    let user_content = build_user_message_content(&prompt, &context_items);

    let raw_model_id = model.unwrap_or_else(|| "llama-3.3-70b-versatile".to_string());
    let has_images = !extract_images_from_context(&context_items).is_empty();
    let is_openrouter = provider == AIProvider::OpenRouter || raw_model_id.contains('/');

    let model_id = if is_openrouter {
        let normalized = normalize_model_for_openrouter(&raw_model_id);
        if has_images && (normalized.contains("llama-3.3-70b") || normalized.contains("deepseek") || normalized.contains("qwen") || normalized.contains("o3-mini")) {
            // Auto-route text-only models to Claude 3.5 Sonnet on OpenRouter when screenshot is attached
            "anthropic/claude-3.5-sonnet".to_string()
        } else {
            normalized
        }
    } else if provider == AIProvider::Groq && has_images {
        "llama-3.2-11b-vision-preview".to_string()
    } else {
        raw_model_id
    };

    let is_openrouter_model = is_openrouter;

    let (url, provider_name, target_key) = if is_openrouter_model {
        ("https://openrouter.ai/api/v1/chat/completions", "OpenRouter", Some(api_key.clone()))
    } else if provider == AIProvider::OpenAI {
        ("https://api.openai.com/v1/chat/completions", "OpenAI", Some(api_key.clone()))
    } else {
        ("https://api.groq.com/openai/v1/chat/completions", "Groq", Some(api_key.clone()))
    };

    let active_key = match target_key {
        Some(k) if !k.trim().is_empty() => k,
        _ => {
            let err_msg = format!("⚠️ API Key Required: Please add your {} API key in Settings to use model '{}'.", provider_name, model_id);
            let _ = app.emit("ai_stream_chunk", &err_msg);
            let _ = app.emit("ai_stream_done", "");
            return Ok(());
        }
    };

    let secondary_fallback = if !is_openrouter_model {
        "llama-3.1-8b-instant"
    } else if model_id != "~anthropic/claude-sonnet-latest" {
        "~anthropic/claude-sonnet-latest"
    } else {
        "google/gemini-2.0-flash-001"
    };

    let max_tokens: u32 = if prompt.contains("(BRIEF") {
        1200
    } else if prompt.contains("(DETAILED") {
        3072
    } else {
        2048
    };

    let client = reqwest::Client::new();
    let build_req = |m_id: &str| {
        let mut r = client.post(url)
            .header("Authorization", format!("Bearer {}", active_key))
            .header("Content-Type", "application/json");
        if is_openrouter_model {
            r = r.header("HTTP-Referer", "https://github.com/hackysack")
                 .header("X-Title", "HackySack");
        }
        let b = serde_json::json!({
            "model": m_id,
            "messages": [
                { "role": "system", "content": system_prompt },
                { "role": "user",   "content": user_content }
            ],
            "max_tokens": max_tokens,
            "temperature": 0.3,
            "stream": true
        });
        r.json(&b)
    };

    let provider_name = if provider == AIProvider::Groq { "Groq" } else { "OpenRouter" };
    let mut response_res = build_req(&model_id).send().await;

    // Retry with secondary fallback model if primary request failed
    if response_res.is_err() && model_id != secondary_fallback {
        response_res = build_req(secondary_fallback).send().await;
    }

    let mut response = match response_res {
        Ok(resp) => resp,
        Err(e) => {
            let err_msg = format!("⚠️ {} Stream Failed: {}", provider_name, e);
            let _ = app.emit("ai_stream_chunk", &err_msg);
            let _ = app.emit("ai_stream_done", "");
            return Ok(());
        }
    };

    // Retry with secondary fallback model if primary returned HTTP error (e.g. rate limit 429)
    if !response.status().is_success() && model_id != secondary_fallback {
        if let Ok(fb_resp) = build_req(secondary_fallback).send().await {
            if fb_resp.status().is_success() {
                response = fb_resp;
            }
        }
    }

    if !response.status().is_success() {
        let status = response.status();
        let err_text = response.text().await.unwrap_or_default();
        let err_msg = format!("⚠️ {} API Error (HTTP {}): {}", provider_name, status, err_text);
        let _ = app.emit("ai_stream_chunk", &err_msg);
        let _ = app.emit("ai_stream_done", "");
        return Ok(());
    }

    let mut stream = response.bytes_stream();
    let mut buffer = String::new();

    while let Some(chunk) = stream.next().await {
        let bytes = match chunk {
            Ok(b) => b,
            Err(e) => {
                let err_msg = format!("\n[Stream read error: {}]", e);
                let _ = app.emit("ai_stream_chunk", &err_msg);
                break;
            }
        };
        buffer.push_str(&String::from_utf8_lossy(&bytes));

        while let Some(pos) = buffer.find('\n') {
            let line = buffer[..pos].trim().to_string();
            buffer.drain(..=pos);

            if let Some(rest) = line.strip_prefix("data:") {
                let data_str = rest.trim();
                if data_str == "[DONE]" {
                    let _ = app.emit("ai_stream_done", "");
                    return Ok(());
                }
                if let Ok(json) = serde_json::from_str::<serde_json::Value>(data_str) {
                    if let Some(token) = json["choices"][0]["delta"]["content"].as_str() {
                        let _ = app.emit("ai_stream_chunk", token);
                    } else if let Some(token) = json["choices"][0]["text"].as_str() {
                        let _ = app.emit("ai_stream_chunk", token);
                    }
                }
            }
        }
    }

    // Flush remaining buffer
    let remaining = buffer.trim();
    if let Some(rest) = remaining.strip_prefix("data:") {
        let data_str = rest.trim();
        if data_str != "[DONE]" {
            if let Ok(json) = serde_json::from_str::<serde_json::Value>(data_str) {
                if let Some(token) = json["choices"][0]["delta"]["content"].as_str() {
                    let _ = app.emit("ai_stream_chunk", token);
                } else if let Some(token) = json["choices"][0]["text"].as_str() {
                    let _ = app.emit("ai_stream_chunk", token);
                }
            }
        }
    }

    let _ = app.emit("ai_stream_done", "");
    Ok(())
}

async fn call_openrouter(
    api_key: &str,
    prompt: &str,
    context: &str,
    model: Option<String>,
) -> Result<AIResponse, String> {
    let client = reqwest::Client::new();
    let model_id = model.unwrap_or_else(|| "meta-llama/llama-3.1-8b-instruct".to_string());

    let system_prompt = build_system_prompt(context);

    let body = serde_json::json!({
        "model": model_id,
        "messages": [
            { "role": "system", "content": system_prompt },
            { "role": "user", "content": prompt }
        ],
        "max_tokens": 1500,
        "temperature": 0.7
    });

    let response = client
        .post("https://openrouter.ai/api/v1/chat/completions")
        .header("Authorization", format!("Bearer {}", api_key))
        .header("HTTP-Referer", "https://github.com/hackysack") // Recommended by OpenRouter
        .header("X-Title", "HackySack") // Recommended by OpenRouter
        .header("Content-Type", "application/json")
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("OpenRouter request failed: {}", e))?;

    if !response.status().is_success() {
        let err_text = response.text().await.unwrap_or_default();
        return Err(format!("OpenRouter API error: {}", err_text));
    }

    let json: serde_json::Value = response
        .json()
        .await
        .map_err(|e| format!("Failed to parse OpenRouter response: {}", e))?;

    let content = json["choices"][0]["message"]["content"]
        .as_str()
        .unwrap_or("No response content")
        .to_string();

    let tokens = json["usage"]["total_tokens"]
        .as_u64()
        .unwrap_or(0) as u32;

    Ok(AIResponse {
        content,
        model_used: model_id,
        tokens_used: tokens,
        success: true,
    })
}

/// Validates an AI API key by making a lightweight test request to the provider
#[tauri::command]
pub async fn verify_ai_key(key: String, provider: String) -> Result<String, String> {
    let key_trimmed = key.trim();
    if key_trimmed.is_empty() {
        return Err("API Key cannot be empty.".to_string());
    }

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(10))
        .build()
        .map_err(|e| format!("Failed to create client: {}", e))?;

    match provider.as_str() {
        "groq" => {
            let res = client.get("https://api.groq.com/openai/v1/models")
                .header("Authorization", format!("Bearer {}", key_trimmed))
                .send()
                .await
                .map_err(|e| format!("Network error connecting to Groq: {}", e))?;
            let status_code = res.status().as_u16();
            if res.status().is_success() {
                Ok("Groq API key verified successfully!".to_string())
            } else {
                let err_body = res.text().await.unwrap_or_default();
                Err(format!("Groq key verification failed (HTTP {}): {}", status_code, err_body))
            }
        },
        "openai" => {
            let res = client.get("https://api.openai.com/v1/models")
                .header("Authorization", format!("Bearer {}", key_trimmed))
                .send()
                .await
                .map_err(|e| format!("Network error connecting to OpenAI: {}", e))?;
            let status_code = res.status().as_u16();
            if res.status().is_success() {
                Ok("OpenAI API key verified successfully!".to_string())
            } else {
                let err_body = res.text().await.unwrap_or_default();
                Err(format!("OpenAI key verification failed (HTTP {}): {}", status_code, err_body))
            }
        },
        "openrouter" => {
            let res = client.get("https://openrouter.ai/api/v1/auth/key")
                .header("Authorization", format!("Bearer {}", key_trimmed))
                .send()
                .await
                .map_err(|e| format!("Network error connecting to OpenRouter: {}", e))?;
            let status_code = res.status().as_u16();
            if res.status().is_success() {
                Ok("OpenRouter API key verified successfully!".to_string())
            } else {
                let err_body = res.text().await.unwrap_or_default();
                Err(format!("OpenRouter key verification failed (HTTP {}): {}", status_code, err_body))
            }
        },
        "anthropic" => {
            let res = client.post("https://api.anthropic.com/v1/messages")
                .header("x-api-key", key_trimmed)
                .header("anthropic-version", "2023-06-01")
                .header("content-type", "application/json")
                .json(&serde_json::json!({
                    "model": "claude-3-haiku-20240307",
                    "max_tokens": 5,
                    "messages": [{"role": "user", "content": "ping"}]
                }))
                .send()
                .await
                .map_err(|e| format!("Network error connecting to Anthropic: {}", e))?;
            let status_code = res.status().as_u16();
            if res.status().is_success() {
                Ok("Anthropic API key verified successfully!".to_string())
            } else {
                let err_body = res.text().await.unwrap_or_default();
                Err(format!("Anthropic key verification failed (HTTP {}): {}", status_code, err_body))
            }
        },
        "gemini" => {
            let url = format!("https://generativelanguage.googleapis.com/v1beta/models?key={}", key_trimmed);
            let res = client.get(&url)
                .send()
                .await
                .map_err(|e| format!("Network error connecting to Gemini: {}", e))?;
            let status_code = res.status().as_u16();
            if res.status().is_success() {
                Ok("Google Gemini API key verified successfully!".to_string())
            } else {
                let err_body = res.text().await.unwrap_or_default();
                Err(format!("Gemini key verification failed (HTTP {}): {}", status_code, err_body))
            }
        },
        _ => Err(format!("Unknown provider: {}", provider)),
    }
}

/// Validates a speech/transcription API key
#[tauri::command]
pub async fn verify_speech_key(key: String) -> Result<String, String> {
    let key_trimmed = key.trim();
    if key_trimmed.is_empty() {
        return Err("Voice API Key cannot be empty.".to_string());
    }

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(10))
        .build()
        .map_err(|e| format!("Failed to create client: {}", e))?;

    if key_trimmed.starts_with("gsk_") {
        let res = client.get("https://api.groq.com/openai/v1/models")
            .header("Authorization", format!("Bearer {}", key_trimmed))
            .send()
            .await
            .map_err(|e| format!("Network error connecting to Groq: {}", e))?;
        let status_code = res.status().as_u16();
        if res.status().is_success() {
            Ok("Groq Voice-to-Text key verified successfully!".to_string())
        } else {
            let err_body = res.text().await.unwrap_or_default();
            Err(format!("Groq Voice key verification failed (HTTP {}): {}", status_code, err_body))
        }
    } else {
        let res = client.get("https://api.openai.com/v1/models")
            .header("Authorization", format!("Bearer {}", key_trimmed))
            .send()
            .await
            .map_err(|e| format!("Network error connecting to OpenAI: {}", e))?;
        let status_code = res.status().as_u16();
        if res.status().is_success() {
            Ok("OpenAI Voice-to-Text key verified successfully!".to_string())
        } else {
            let err_body = res.text().await.unwrap_or_default();
            Err(format!("OpenAI Voice key verification failed (HTTP {}): {}", status_code, err_body))
        }
    }
}



