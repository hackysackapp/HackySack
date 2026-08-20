// Screen capture protection and Win32 click-through overlay

use serde::{Deserialize, Serialize};
use tauri::WebviewWindow;

#[derive(Debug, Serialize, Deserialize)]
pub struct StealthStatus {
    pub protected: bool,
    pub always_on_top: bool,
    pub platform: String,
}

// Win32 API FFI for SetWindowDisplayAffinity
#[cfg(target_os = "windows")]
pub fn apply_screen_protection(window: &WebviewWindow, protect: bool) -> Result<bool, String> {
    #[link(name = "user32")]
    extern "system" {
        fn SetWindowDisplayAffinity(hwnd: *mut std::ffi::c_void, dw_affinity: u32) -> i32;
    }

    let hwnd = window.hwnd().map_err(|e| format!("Failed to retrieve window handle: {}", e))?;
    let raw_hwnd = hwnd.0;

    let affinity: u32 = if protect { 0x00000011 } else { 0x00000000 };

    let res = unsafe { SetWindowDisplayAffinity(raw_hwnd, affinity) };
    if res == 0 && protect {
        let fallback_res = unsafe { SetWindowDisplayAffinity(raw_hwnd, 0x00000001) };
        if fallback_res == 0 {
            return Err("SetWindowDisplayAffinity Win32 call failed".to_string());
        }
    }

    println!("🔒 [Stealth Mode] Screen capture protection (WDA_EXCLUDEFROMCAPTURE): {}", protect);
    let _ = apply_toolwindow_style(window);
    Ok(protect)
}

#[cfg(target_os = "windows")]
pub fn apply_toolwindow_style(window: &WebviewWindow) -> Result<(), String> {
    #[link(name = "user32")]
    extern "system" {
        fn GetWindowLongW(hwnd: *mut std::ffi::c_void, n_index: i32) -> i32;
        fn SetWindowLongW(hwnd: *mut std::ffi::c_void, n_index: i32, dw_new_long: i32) -> i32;
    }
    let hwnd = window.hwnd().map_err(|e| format!("Failed to retrieve window handle: {}", e))?;
    let raw_hwnd = hwnd.0;
    unsafe {
        let ex_style = GetWindowLongW(raw_hwnd, -20); // GWL_EXSTYLE = -20
        let new_ex_style = (ex_style | 0x00000080) & !0x00040000; // WS_EX_TOOLWINDOW | ~WS_EX_APPWINDOW
        SetWindowLongW(raw_hwnd, -20, new_ex_style);
    }
    Ok(())
}

#[cfg(not(target_os = "windows"))]
pub fn apply_screen_protection(_window: &WebviewWindow, protect: bool) -> Result<bool, String> {
    println!("🔒 [Stealth Mode] Screen capture protection requested ({}), OS is non-Windows", protect);
    Ok(protect)
}

// Win32 dynamic click-through (toggles WS_EX_TRANSPARENT via subclass)
#[cfg(target_os = "windows")]
mod win32_clickthrough {
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::Mutex;
    use std::time::Duration;
    use tauri::WebviewWindow;

    pub static CLICK_THROUGH_ACTIVE: AtomicBool = AtomicBool::new(false);
    static POLL_THREAD_RUNNING: AtomicBool = AtomicBool::new(false);

    #[derive(Debug, Clone, serde::Deserialize)]
    pub struct RectRegion {
        pub x: i32,
        pub y: i32,
        pub width: i32,
        pub height: i32,
    }

    pub static INTERACTIVE_REGIONS: Mutex<Vec<RectRegion>> = Mutex::new(Vec::new());

    #[repr(C)]
    struct POINT {
        x: i32,
        y: i32,
    }

    #[repr(C)]
    struct RECT {
        left: i32,
        top: i32,
        right: i32,
        bottom: i32,
    }

    #[link(name = "user32")]
    extern "system" {
        fn GetCursorPos(lp_point: *mut POINT) -> i32;
        fn ScreenToClient(hwnd: *mut std::ffi::c_void, lp_point: *mut POINT) -> i32;
        fn GetWindowRect(hwnd: *mut std::ffi::c_void, lp_rect: *mut RECT) -> i32;
        fn GetAsyncKeyState(v_key: i32) -> i16;
    }

    pub fn apply_click_through(window: &WebviewWindow, ignore: bool) {
        CLICK_THROUGH_ACTIVE.store(ignore, Ordering::SeqCst);
        
        if ignore {
            // Start polling thread if not already running
            if !POLL_THREAD_RUNNING.swap(true, Ordering::SeqCst) {
                let win_clone = window.clone();
                std::thread::spawn(move || {
                    let mut last_ignore_state = true;
                    let mut is_dragging = false;
                    
                    // Start in pass-through mode
                    let _ = win_clone.set_ignore_cursor_events(true);
                    
                    while CLICK_THROUGH_ACTIVE.load(Ordering::SeqCst) {
                        let mut should_ignore = true;
                        let lbutton_down = unsafe { GetAsyncKeyState(0x01) } < 0; // VK_LBUTTON (0x01)
                        
                        if let Ok(hwnd) = win_clone.hwnd() {
                            let raw_hwnd = hwnd.0 as *mut std::ffi::c_void;
                            
                            let mut pt = POINT { x: 0, y: 0 };
                            unsafe { GetCursorPos(&mut pt) };
                            
                            let mut client_pt = POINT { x: pt.x, y: pt.y };
                            unsafe { ScreenToClient(raw_hwnd, &mut client_pt) };
                            
                            let mut rect = RECT { left: 0, top: 0, right: 0, bottom: 0 };
                            unsafe { GetWindowRect(raw_hwnd, &mut rect) };
                            let win_height = rect.bottom - rect.top;
                            let win_width = rect.right - rect.left;
                            
                            // Zone 1: Top Application Bar (top 50px - Titlebar, Window Controls _ □ ✕, Topbar Actions)
                            let is_in_topbar = client_pt.y >= 0 && client_pt.y <= 50;

                            // Zone 2: Bottom Command Dock & Status Bar (bottom 160px - Prompt text box, Ask AI, +History, Model select, Length pills, Opacity slider)
                            let is_in_bottom_dock = client_pt.y >= (win_height - 160) && client_pt.y <= win_height;

                            // Zone 3: Middle Area AI Response Scrollbar ONLY (rightmost 22px of window)
                            let is_in_ai_scrollbar = client_pt.x >= (win_width - 22) && client_pt.x <= win_width && client_pt.y >= 50 && client_pt.y <= (win_height - 160);
                            
                            let mut in_interactive_region = false;
                            if let Ok(regions) = INTERACTIVE_REGIONS.lock() {
                                for region in regions.iter() {
                                    if client_pt.x >= region.x && client_pt.x <= (region.x + region.width) &&
                                       client_pt.y >= region.y && client_pt.y <= (region.y + region.height) {
                                        in_interactive_region = true;
                                        break;
                                    }
                                }
                            }
                            
                            if is_in_topbar || is_in_bottom_dock || is_in_ai_scrollbar || in_interactive_region {
                                should_ignore = false; // Mouse is over topbar, bottom dock, or right scrollbar -> INTERACTIVE
                            }
                            
                            // Lock interactive focus while mouse button is pressed over any control
                            if lbutton_down && !should_ignore {
                                is_dragging = true;
                            }
                            if !lbutton_down {
                                is_dragging = false;
                            }
                            if is_dragging {
                                should_ignore = false;
                            }
                        }
                        
                        if should_ignore != last_ignore_state {
                            let _ = win_clone.set_ignore_cursor_events(should_ignore);
                            last_ignore_state = should_ignore;
                        }
                        
                        std::thread::sleep(Duration::from_millis(16)); // ~60 FPS
                    }
                    
                    // Cleanup when deactivated
                    let _ = win_clone.set_ignore_cursor_events(false);
                    POLL_THREAD_RUNNING.store(false, Ordering::SeqCst);
                });
            }
        } else {
            let _ = window.set_ignore_cursor_events(false);
        }
    }
}


#[tauri::command]
pub fn set_screen_protection(window: WebviewWindow, protect: bool) -> Result<StealthStatus, String> {
    let result = apply_screen_protection(&window, protect)?;
    Ok(StealthStatus {
        protected: result,
        always_on_top: window.is_always_on_top().unwrap_or(false),
        platform: std::env::consts::OS.to_string(),
    })
}


#[tauri::command]
pub fn set_always_on_top(window: WebviewWindow, always_on_top: bool) -> Result<bool, String> {
    window.set_always_on_top(always_on_top).map_err(|e| e.to_string())?;
    println!("📌 [Stealth Mode] Always on Top set to: {}", always_on_top);
    Ok(always_on_top)
}


#[tauri::command]
pub async fn set_click_through(window: WebviewWindow, ignore: bool) -> Result<bool, String> {
    #[cfg(target_os = "windows")]
    win32_clickthrough::apply_click_through(&window, ignore);

    #[cfg(not(target_os = "windows"))]
    let _ = window.set_ignore_cursor_events(ignore);

    println!("🖱️ [Stealth Mode] Dynamic Click-Through set to: {}", ignore);
    Ok(ignore)
}


#[tauri::command]
pub fn set_interactive_regions(regions: Vec<win32_clickthrough::RectRegion>) {
    #[cfg(target_os = "windows")]
    {
        if let Ok(mut lock) = win32_clickthrough::INTERACTIVE_REGIONS.lock() {
            *lock = regions;
        }
    }
}


#[tauri::command]
pub fn toggle_window_visibility(window: WebviewWindow) -> Result<bool, String> {
    let is_visible = window.is_visible().unwrap_or(true);
    let is_minimized = window.is_minimized().unwrap_or(false);

    if is_visible && !is_minimized {
        let _ = window.hide();
        Ok(false)
    } else {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
        Ok(true)
    }
}


#[tauri::command]
pub fn get_screen_protection_status(window: WebviewWindow) -> Result<StealthStatus, String> {
    Ok(StealthStatus {
        protected: true,
        always_on_top: window.is_always_on_top().unwrap_or(false),
        platform: std::env::consts::OS.to_string(),
    })
}
