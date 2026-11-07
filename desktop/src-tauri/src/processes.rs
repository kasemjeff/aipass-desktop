//! Processes, the log, and the native alert.
//!
//! Taking the backend down with the app, the rotated backend log the
//! supervisor and the child share, opening a folder in the platform
//! file manager, and the message box a console-less release build needs
//! to say anything at all.

use std::io::Write;
use std::process::Command;
use std::time::Duration;

use crate::paths::aipass_home;

/// Open a folder in the platform's file manager. The log folder is where a
/// person is sent when something looks wrong — the alerts name the path, and
/// this opens it without the copying. A missing helper binary is noted, not
/// fatal: the path is still on screen to open by hand.
pub(crate) fn reveal_folder(path: &std::path::Path) {
    let _ = std::fs::create_dir_all(path);
    #[cfg(target_os = "windows")]
    let opened = std::process::Command::new("explorer").arg(path).spawn();
    #[cfg(target_os = "macos")]
    let opened = std::process::Command::new("open").arg(path).spawn();
    #[cfg(all(unix, not(target_os = "macos")))]
    let opened = std::process::Command::new("xdg-open").arg(path).spawn();
    if let Err(err) = opened {
        note(&format!("เปิดโฟลเดอร์ไม่ได้: {} — {err}", path.display()));
    }
}

/// Take the backend down with the app.
///
/// The child runs in its own process group on unix (set when it is spawned),
/// so one signal reaches both the backend and the bridge it started. On
/// Windows the graceful first ask is `taskkill` without `/F` — it posts a
/// close, which a console child may take a moment to act on; three seconds
/// later the forced one goes out anyway. The app is quitting, so patience
/// here is bounded: a child that will not leave does not hold the door.
#[cfg(windows)]
pub(crate) fn stop_backend(pid: u32) {
    let _ = Command::new("taskkill")
        .args(["/PID", &pid.to_string(), "/T"])
        .status();
    for _ in 0..30 {
        if !pid_alive(pid) {
            return;
        }
        std::thread::sleep(Duration::from_millis(100));
    }
    let _ = Command::new("taskkill")
        .args(["/PID", &pid.to_string(), "/T", "/F"])
        .status();
}

/// Is the pid still on the machine? `taskkill`'s own exit code cannot say —
/// it succeeds when the request was sent, not when the process is gone.
#[cfg(windows)]
pub(crate) fn pid_alive(pid: u32) -> bool {
    match Command::new("tasklist")
        .args(["/FI", &format!("PID eq {pid}"), "/NH", "/FO", "CSV"])
        .output()
    {
        Ok(out) => tasklist_says_alive(pid, &String::from_utf8_lossy(&out.stdout)),
        // Cannot ask — assume alive and take the forced path: quitting must
        // not hang on a question the machine would not answer.
        Err(_) => true,
    }
}

/// The CSV line for a found pid quotes it; an empty filter answer says
/// "INFO: no tasks". The quotes are the fact, the rest is decoration.
#[cfg(windows)]
pub(crate) fn tasklist_says_alive(pid: u32, stdout: &str) -> bool {
    stdout.contains(&format!("\"{pid}\""))
}

#[cfg(not(windows))]
pub(crate) fn stop_backend(pid: u32) {
    let _ = Command::new("kill").args(["-TERM", &format!("-{pid}")]).status();
}

/// The backend's log file, rotated past 5 MB the same way the JS side does
/// (harness/log-file.mjs keeps the same number).
///
/// A release build is a GUI app with no console: an inherited stdout/stderr
/// has nowhere to land, so a packaged crash used to leave nothing readable
/// behind. The supervisor redirects the child's output here instead.
pub(crate) fn backend_log_file() -> Option<std::fs::File> {
    let dir = aipass_home().join("logs");
    std::fs::create_dir_all(&dir).ok()?;
    let path = dir.join("desktop-backend.log");
    if let Ok(meta) = std::fs::metadata(&path) {
        if meta.len() > 5 * 1024 * 1024 {
            let _ = std::fs::remove_file(dir.join("desktop-backend.log.1"));
            let _ = std::fs::rename(&path, dir.join("desktop-backend.log.1"));
        }
    }
    std::fs::OpenOptions::new().create(true).append(true).open(&path).ok()
}

/// One supervisor line, in the same log the child writes to: who restarted
/// what, and when — the question a packaged crash otherwise leaves open.
pub(crate) fn note(msg: &str) {
    if let Some(mut file) = backend_log_file() {
        let _ = writeln!(file, "[supervisor] {msg}");
    }
}

/// The backend log's path, for the messages that name it.
pub(crate) fn backend_log_path() -> std::path::PathBuf {
    aipass_home().join("logs").join("desktop-backend.log")
}

/// A native message box, for the deaths a release build cannot print.
///
/// `windows_subsystem = "windows"` means no console: an `expect()` on a
/// failed spawn used to die silently and the window simply never came. The
/// dialog is std-only — `MessageBoxW` straight from user32 — so the
/// no-new-dependency rule holds.
#[cfg(windows)]
pub(crate) fn alert(title: &str, body: &str) {
    use std::os::windows::ffi::OsStrExt;
    let wide = |s: &str| -> Vec<u16> {
        let mut v: Vec<u16> = std::ffi::OsStr::new(s).encode_wide().collect();
        v.push(0);
        v
    };
    #[link(name = "user32")]
    extern "system" {
        fn MessageBoxW(hwnd: isize, text: *const u16, caption: *const u16, kind: u32) -> i32;
    }
    let text = wide(body);
    let caption = wide(title);
    // MB_ICONERROR (0x10), MB_SETFOREGROUND (0x10000) so it is not painted
    // behind the taskbar on a cold start.
    unsafe {
        MessageBoxW(0, text.as_ptr(), caption.as_ptr(), 0x10 | 0x1_0000);
    }
}

#[cfg(not(windows))]
pub(crate) fn alert(_title: &str, body: &str) {
    eprintln!("{body}");
}
