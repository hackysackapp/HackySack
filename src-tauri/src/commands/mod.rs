pub mod ai;
pub mod audio;
pub mod documents;
pub mod screenshot;
pub mod stealth;

/// Simple ping command for testing the JS ↔ Rust bridge
#[tauri::command]
pub fn ping(message: String) -> Result<String, String> {
    Ok(format!("🏓 Pong from Rust! You said: '{}'", message))
}
