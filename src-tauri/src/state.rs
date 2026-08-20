use std::sync::{Arc, Mutex};
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ContextItem {
    pub id: String,
    pub kind: ContextKind,
    pub content: String,
    pub timestamp: u64,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub enum ContextKind {
    Audio,
    Screenshot,
    Text,
    Document,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub enum AIProvider {
    OpenAI,
    Anthropic,
    Gemini,
    Groq,
    OpenRouter,
}

impl Default for AIProvider {
    fn default() -> Self {
        AIProvider::Groq
    }
}

/// Shared application state managed by Tauri and accessible across commands
#[derive(Debug)]
pub struct AppState {
    pub context_buffer: Arc<Mutex<Vec<ContextItem>>>,
    pub api_key: Arc<Mutex<Option<String>>>,
    pub transcription_api_key: Arc<Mutex<Option<String>>>,
    pub ai_provider: Arc<Mutex<AIProvider>>,
    #[allow(dead_code)]
    pub is_recording: Arc<Mutex<bool>>,
    #[allow(dead_code)]
    pub last_response: Arc<Mutex<Option<String>>>,
    pub use_cloud_mode: Arc<Mutex<bool>>,
    pub cloud_jwt: Arc<Mutex<Option<String>>>,
    pub cloud_endpoint: Arc<Mutex<String>>,
    pub just_activated: Arc<Mutex<bool>>,
}

impl Default for AppState {
    fn default() -> Self {
        AppState {
            context_buffer: Arc::new(Mutex::new(Vec::new())),
            api_key: Arc::new(Mutex::new(None)),
            transcription_api_key: Arc::new(Mutex::new(None)),
            ai_provider: Arc::new(Mutex::new(AIProvider::default())),
            is_recording: Arc::new(Mutex::new(false)),
            last_response: Arc::new(Mutex::new(None)),
            use_cloud_mode: Arc::new(Mutex::new(false)),
            cloud_jwt: Arc::new(Mutex::new(None)),
            cloud_endpoint: Arc::new(Mutex::new("https://vzuutupafqjrmfuncgxl.supabase.co/functions/v1/ai-proxy".to_string())),
            just_activated: Arc::new(Mutex::new(false)),
        }
    }
}

impl AppState {
    /// Appends a new item to the shared context buffer
    pub fn add_context(&self, item: ContextItem) {
        let mut buffer = self.context_buffer.lock().unwrap();
        buffer.push(item);
    }

    /// Clears all entries in the context buffer
    #[allow(dead_code)]
    pub fn clear_context(&self) {
        let mut buffer = self.context_buffer.lock().unwrap();
        buffer.clear();
    }

    /// Returns a cloned snapshot of the current context buffer
    #[allow(dead_code)]
    pub fn get_context_snapshot(&self) -> Vec<ContextItem> {
        let buffer = self.context_buffer.lock().unwrap();
        buffer.clone()
    }
}
