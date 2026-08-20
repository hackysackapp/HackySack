mod commands;
mod state;

use state::AppState;
use tauri::Emitter;
use tauri::Manager;

fn parse_deep_link_token(arg: &str) -> Option<String> {
    for key in &["token=", "jwt=", "key=", "access_token="] {
        if let Some(pos) = arg.find(key) {
            let rest = &arg[pos + key.len()..];
            let token = rest.split('&').next().unwrap_or(rest).trim().trim_matches('"').trim_matches('\'').trim_end_matches('/');
            if !token.is_empty() {
                return Some(token.to_string());
            }
        }
    }
    if let Some(hs_pos) = arg.find("hs_") {
        let rest = &arg[hs_pos..];
        let token = rest.split(|c: char| !c.is_alphanumeric() && c != '_' && c != '-').next().unwrap_or(rest).trim_end_matches('/');
        if !token.is_empty() {
            return Some(token.to_string());
        }
    }
    let lower_arg = arg.to_lowercase();
    if lower_arg.starts_with("hackysack://") && (lower_arg.contains("activate") || lower_arg.contains("auth")) {
        return Some("hs_cloud_active".to_string());
    }
    None
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .plugin(tauri_plugin_log::Builder::new().build())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
            for arg in argv {
                if let Some(token) = parse_deep_link_token(&arg) {
                    let state_ref = app.state::<AppState>();
                    if let Ok(mut mode_guard) = state_ref.use_cloud_mode.lock() {
                        *mode_guard = true;
                    }
                    if let Ok(mut jwt_guard) = state_ref.cloud_jwt.lock() {
                        *jwt_guard = Some(token.clone());
                    }
                    if let Ok(mut just_guard) = state_ref.just_activated.lock() {
                        *just_guard = true;
                    }
                    let _ = commands::ai::save_to_keyring("cloud_mode", "true");
                    let _ = commands::ai::save_to_keyring("cloud_jwt", &token);
                    let _ = commands::ai::save_to_keyring("cloud_endpoint", "https://vzuutupafqjrmfuncgxl.supabase.co/functions/v1/ai-proxy");

                    let payload = serde_json::json!({
                        "token": token.clone(),
                        "url": arg.clone()
                    });

                    let _ = app.emit("cloud-activated", payload.clone());
                    let _ = app.emit("deep-link-received", payload.clone());
                    let _ = app.emit("deep-link://new-url", vec![arg.clone()]);

                    if let Some(window) = app.get_webview_window("main") {
                        let _ = window.emit("cloud-activated", payload.clone());
                        let _ = window.emit("deep-link-received", payload);
                    }
                }
            }
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.unminimize();
                let _ = window.show();
                let _ = window.set_always_on_top(true);
                let _ = window.set_focus();
            }
        }))
        .setup(|app| {
            app.manage(AppState::default());

            // 1. Restore Cloud Mode state from OS Keyring on startup ONLY IF valid token exists
            let state_ref = app.state::<AppState>();
            let cloud_jwt = commands::ai::get_from_keyring("cloud_jwt");
            let has_jwt = cloud_jwt.as_ref().map(|j| !j.trim().is_empty()).unwrap_or(false);
            let mode = commands::ai::get_from_keyring("cloud_mode");
            let is_cloud_active = mode.as_deref() == Some("true") && has_jwt;

            if let Ok(mut mode_guard) = state_ref.use_cloud_mode.lock() {
                *mode_guard = is_cloud_active;
            }
            if let Ok(mut jwt_guard) = state_ref.cloud_jwt.lock() {
                *jwt_guard = if is_cloud_active { cloud_jwt } else { None };
            }
            if let Some(ep) = commands::ai::get_from_keyring("cloud_endpoint") {
                if !ep.trim().is_empty() {
                    if let Ok(mut ep_guard) = state_ref.cloud_endpoint.lock() {
                        *ep_guard = ep;
                    }
                }
            }

            // 2. Check if app was launched via deep link URL
            for arg in std::env::args() {
                if let Some(token) = parse_deep_link_token(&arg) {
                    if let Ok(mut mode_guard) = state_ref.use_cloud_mode.lock() {
                        *mode_guard = true;
                    }
                    if let Ok(mut jwt_guard) = state_ref.cloud_jwt.lock() {
                        *jwt_guard = Some(token.clone());
                    }
                    if let Ok(mut just_guard) = state_ref.just_activated.lock() {
                        *just_guard = true;
                    }
                    let _ = commands::ai::save_to_keyring("cloud_mode", "true");
                    let _ = commands::ai::save_to_keyring("cloud_jwt", &token);
                    let _ = commands::ai::save_to_keyring("cloud_endpoint", "https://vzuutupafqjrmfuncgxl.supabase.co/functions/v1/ai-proxy");
                }
            }

            // Hide window from screen capture/recording software on startup
            if let Some(window) = app.get_webview_window("main") {
                let _ = commands::stealth::apply_screen_protection(&window, true);
            }

            // Global hotkeys:
            // Ctrl+Shift+H: toggles window visibility from anywhere in the OS
            // Ctrl+Shift+S: triggers instant screenshot capture at cursor from anywhere in the OS
            let app_handle = app.handle().clone();
            let app_handle_screenshot = app.handle().clone();
            use tauri_plugin_global_shortcut::{GlobalShortcutExt, ShortcutState};

            let _ = app.global_shortcut().on_shortcut("Ctrl+Shift+H", move |_app, _shortcut, event| {
                if event.state() == ShortcutState::Pressed {
                    if let Some(window) = app_handle.get_webview_window("main") {
                        let is_visible = window.is_visible().unwrap_or(true);
                        let is_minimized = window.is_minimized().unwrap_or(false);
                        if is_visible && !is_minimized {
                            let _ = window.hide();
                        } else {
                            let _ = window.unminimize();
                            let _ = window.show();
                            let _ = window.set_focus();
                        }
                    }
                }
            });

            let _ = app.global_shortcut().on_shortcut("Ctrl+Shift+S", move |_app, _shortcut, event| {
                if event.state() == ShortcutState::Pressed {
                    let _ = app_handle_screenshot.emit("trigger_screenshot_capture", ());
                }
            });

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::ai::ask_ai,
            commands::ai::ask_ai_stream,
            commands::ai::set_api_key,
            commands::ai::set_cloud_config,
            commands::ai::get_cloud_config,
            commands::ai::acknowledge_activation,
            commands::ai::get_available_models,
            commands::ai::verify_ai_key,
            commands::ai::verify_speech_key,
            commands::ai::save_secure_key,
            commands::ai::get_secure_key,
            commands::ai::delete_secure_key,
            commands::audio::transcribe_audio,
            commands::audio::transcribe_dual_native,
            commands::audio::start_native_recording,
            commands::audio::stop_native_recording,
            commands::audio::get_audio_devices,
            commands::screenshot::capture_screenshot,
            commands::documents::parse_document,
            commands::documents::save_context_document,
            commands::documents::open_file_path,
            commands::stealth::set_screen_protection,
            commands::stealth::set_always_on_top,
            commands::stealth::set_click_through,
            commands::stealth::get_screen_protection_status,
            commands::stealth::set_interactive_regions,
            commands::stealth::toggle_window_visibility,
            commands::ping,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
