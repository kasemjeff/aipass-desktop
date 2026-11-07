//! The window last geometry.
//!
//! Where the window was, how big, and whether it was maximized — so a
//! window does not forget between launches.

use std::path::PathBuf;

use crate::paths::aipass_home;

/// The window's last geometry: where it was, how big, and whether it was
/// maximized. A window that forgets is a window the person re-shapes every
/// morning — the screen did not change overnight, and the app has no excuse.
#[derive(Debug, Clone, Copy, PartialEq, serde::Serialize, serde::Deserialize)]
pub(crate) struct WindowGeometry {
    pub(crate) width: u32,
    pub(crate) height: u32,
    pub(crate) x: i32,
    pub(crate) y: i32,
    pub(crate) maximized: bool,
}

pub(crate) fn window_geometry_path(home: &std::path::Path) -> PathBuf {
    home.join("desktop-window.json")
}

pub(crate) fn load_window_geometry_from(home: &std::path::Path) -> Option<WindowGeometry> {
    let body = std::fs::read_to_string(window_geometry_path(home)).ok()?;
    serde_json::from_str(&body).ok()
}

pub(crate) fn save_window_geometry_to(home: &std::path::Path, geometry: &WindowGeometry) {
    let path = window_geometry_path(home);
    if let Some(dir) = path.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    // A few dozen bytes a person never reads: a torn write costs one
    // default-sized window, not data, so it is written directly.
    let _ = std::fs::write(&path, serde_json::to_string(geometry).unwrap_or_default());
}

pub(crate) fn load_window_geometry() -> Option<WindowGeometry> {
    load_window_geometry_from(&aipass_home())
}
