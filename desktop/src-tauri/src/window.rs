//! The window shell: theme and tray icon.
//!
//! What only the shell can paint — the titlebar theme read before the
//! window opens, and the tray icon (a silhouette template on macOS, the
//! app mark everywhere else).

use crate::paths::aipass_home;

/// The titlebar is the one surface the app cannot paint itself, so Windows
/// draws a light frame over the warm window unless the theme is set before the
/// window opens. The settings file is the only thing that knows this early —
/// the backend that serves settings is not up yet — so read it directly;
/// "auto" hands the frame back to the system, which is what auto means.
pub(crate) fn desktop_theme() -> Option<tauri::Theme> {
    let path = aipass_home().join("settings.json");
    let choice = std::fs::read_to_string(path)
        .ok()
        .and_then(|text| serde_json::from_str::<serde_json::Value>(&text).ok())
        .and_then(|json| json.get("theme")?.as_str().map(str::to_owned));
    match choice.as_deref() {
        Some("light") => Some(tauri::Theme::Light),
        Some("auto") => None,
        _ => Some(tauri::Theme::Dark),
    }
}

/// The tray icon: the silhouette on macOS, the app's mark everywhere else.
///
/// The menu bar draws a template image as a mask — only the alpha channel
/// matters — so the app's mark (a filled rounded square) would be a solid
/// blob there, with the star invisible inside it. The template is the
/// star by itself, written by `icons/make-icons.mjs` next to the PNGs and
/// embedded raw, so the shell needs no image decoder to use it.
pub(crate) fn tray_icon<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> tauri::image::Image<'static> {
    #[cfg(target_os = "macos")]
    {
        return tauri::image::Image::new_owned(
            TEMPLATE_RGBA.to_vec(),
            TEMPLATE_EDGE,
            TEMPLATE_EDGE,
        );
    }
    #[cfg(not(target_os = "macos"))]
    {
        app.default_window_icon()
            .cloned()
            .map(|icon| icon.to_owned())
            .unwrap_or_else(|| {
                // A build with no icon at all must not take the app down
                // before the window exists; the tray still works, it is only
                // blank.
                tauri::image::Image::new_owned(vec![0u8; 4], 1, 1)
            })
    }
}

/// The template's edge, in pixels — 44 is 22pt at the retina scale the menu
/// bar uses.
#[allow(dead_code)]
pub(crate) const TEMPLATE_EDGE: u32 = 44;

/// The template's raw RGBA, written by `icons/make-icons.mjs` beside the
/// PNGs. Embedded raw so the shell needs no image decoder to use it.
#[allow(dead_code)]
pub(crate) const TEMPLATE_RGBA: &[u8] = include_bytes!("../icons/template.rgba");

