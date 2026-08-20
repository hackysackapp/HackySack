use tauri::State;
use crate::state::{AppState, ContextItem, ContextKind};
use serde::{Deserialize, Serialize};
use screenshots::Screen;
use base64::Engine;

#[derive(Debug, Serialize, Deserialize)]
pub struct ScreenshotResult {
    pub success: bool,
    pub base64_image: Option<String>,
    pub width: u32,
    pub height: u32,
    pub context_item_id: Option<String>,
    pub text_summary: Option<String>,
}

/// Captures a live screen snapshot at the current mouse cursor location (supporting multi-monitors)
/// and registers it into the AI context buffer
#[tauri::command]
pub async fn capture_screenshot(state: State<'_, AppState>) -> Result<ScreenshotResult, String> {
    println!("📸 [Screenshot] Capturing screen display at cursor...");

    #[cfg(target_os = "windows")]
    let screen = {
        #[repr(C)]
        struct POINT {
            x: i32,
            y: i32,
        }
        #[link(name = "user32")]
        extern "system" {
            fn GetCursorPos(lp_point: *mut POINT) -> i32;
        }

        let mut pt = POINT { x: 0, y: 0 };
        unsafe { GetCursorPos(&mut pt) };
        println!("📸 [Screenshot] Cursor position: ({}, {})", pt.x, pt.y);

        let all_screens = Screen::all().map_err(|e| format!("Failed to find display screens: {}", e))?;
        
        // Find screen whose bounding box contains the cursor
        let matched = all_screens.into_iter().find(|s| {
            let info = &s.display_info;
            pt.x >= info.x && pt.x < (info.x + info.width as i32) &&
            pt.y >= info.y && pt.y < (info.y + info.height as i32)
        });

        match matched {
            Some(s) => s,
            None => {
                // Fallback to Screen::from_point or first screen
                Screen::from_point(pt.x, pt.y).unwrap_or_else(|_| {
                    let screens = Screen::all().unwrap_or_default();
                    screens.into_iter().next().expect("No screen found")
                })
            }
        }
    };

    #[cfg(not(target_os = "windows"))]
    let screen = {
        let screens = Screen::all().map_err(|e| format!("Failed to find display screens: {}", e))?;
        screens.into_iter().next().ok_or_else(|| "No display screen found".to_string())?
    };

    let image = screen.capture().map_err(|e| format!("Failed to capture screen: {}", e))?;
    let width = image.width();
    let height = image.height();
    let mut buffer = std::io::Cursor::new(Vec::new());
    let _ = image.write_to(&mut buffer, screenshots::image::ImageFormat::Png);
    let png_bytes = buffer.into_inner();
    let base64_data = base64::engine::general_purpose::STANDARD.encode(&png_bytes);
    let image_data_url = format!("data:image/png;base64,{}", base64_data);
    let summary = format!("Active Screen Snapshot ({}x{}). Please solve the coding problem, analyze the system architecture diagram, or answer the questions visible on the candidate's screen.", width, height);

    let item = ContextItem {
        id: format!("screenshot-{}", chrono_timestamp()),
        kind: ContextKind::Screenshot,
        content: image_data_url.clone(),
        timestamp: chrono_timestamp(),
    };

    state.add_context(item.clone());

    Ok(ScreenshotResult {
        success: true,
        base64_image: Some(format!("data:image/png;base64,{}", base64_data)),
        width,
        height,
        context_item_id: Some(item.id),
        text_summary: Some(summary),
    })
}

fn chrono_timestamp() -> u64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_millis() as u64
}

