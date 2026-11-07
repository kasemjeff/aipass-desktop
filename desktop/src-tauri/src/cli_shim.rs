//! The CLI shim.
//!
//! A per-user aipass command that runs the installed app own CLI
//! on the app own Node, and putting its directory on the user PATH.

use std::path::PathBuf;
use std::process::Command;
use tauri::Manager;

use crate::paths::{aipass_home, find_node, home_dir, plain};

pub(crate) fn cli_shim_path() -> PathBuf {
    #[cfg(windows)]
    {
        let base = std::env::var("LOCALAPPDATA")
            .map(PathBuf::from)
            .unwrap_or_else(|_| home_dir().join("AppData").join("Local"));
        base.join("aipass").join("bin").join("aipass.cmd")
    }
    #[cfg(not(windows))]
    {
        home_dir().join(".local").join("bin").join("aipass")
    }
}

/// The stable link the CLI shim names.
///
/// It points at the live content root, so a content update moves the tree
/// without the shim going stale: the CLI and the window run the same code.
pub(crate) fn cli_link() -> PathBuf {
    aipass_home().join("app").join("current")
}

/// The shim's text: the app's own Node, running the app's own CLI.
///
/// The shim does not need Node on PATH — the app ships one — so a machine
/// without Node still gets a working `aipass`.
pub(crate) fn cli_shim_script(node: &std::path::Path, cli: &std::path::Path) -> String {
    #[cfg(windows)]
    {
        format!(
            "@echo off\r\nrem aipass - the CLI of the installed aipass desktop.\r\n\"{}\" \"{}\" %*\r\n",
            node.display(),
            cli.display()
        )
    }
    #[cfg(not(windows))]
    {
        format!(
            "#!/bin/sh\n# aipass - the CLI of the installed aipass desktop.\nexec \"{}\" \"{}\" \"$@\"\n",
            node.display(),
            cli.display()
        )
    }
}

/// Put the shim's directory on the user's PATH.
///
/// A shim in a directory that is not on PATH is a file nobody can run: the
/// window can say where it is, but the person still has to edit PATH by hand
/// — the step that never happens, so the CLI the app installed never gets
/// used. The tray item is already the consent to write to the machine, so the
/// directory goes on PATH with it.
///
/// The user PATH only (`HKCU\Environment`): the machine PATH needs an
/// administrator and is never touched. `reg.exe` is the registry without a
/// crate, and it is the one tool that writes a PATH of any length (setx
/// truncates at 1024 characters).
pub(crate) fn add_to_user_path(dir: &std::path::Path) -> Result<(), String> {
    #[cfg(windows)]
    {
        let dir = dir.to_string_lossy().to_string();
        // "Path    REG_EXPAND_SZ    C:\one;C:\two" — the value is everything
        // after the type, and it may contain spaces.
        let query = Command::new("reg")
            .args(["query", r"HKCU\Environment", "/v", "Path"])
            .output()
            .map_err(|err| format!("reg query failed: {err}"))?;
        let stdout = String::from_utf8_lossy(&query.stdout);
        let (kind, value) = match reg_path_value(&stdout) {
            Some(pair) => pair,
            // No PATH for this user yet: create one, same type as Windows
            // writes by default.
            None => ("REG_EXPAND_SZ".to_string(), String::new()),
        };
        let Some(with_dir) = path_with_dir(&value, &dir) else {
            return Ok(()); // already there
        };
        let status = Command::new("reg")
            .args(["add", r"HKCU\Environment", "/v", "Path", "/t", &kind, "/d", &with_dir, "/f"])
            .status()
            .map_err(|err| format!("reg add failed: {err}"))?;
        if status.success() {
            Ok(())
        } else {
            Err(format!("reg add exited with {status}"))
        }
    }
    #[cfg(not(windows))]
    {
        // The shell profile is the user's own file and the way a Unix PATH
        // grows; the app only says where the shim is, and leaves the profile
        // alone unless it is already there.
        let _ = dir;
        Ok(())
    }
}

/// The PATH value and its registry type, read out of `reg query` output.
///
/// The value is everything after the type column, so a PATH with spaces in
/// it survives: `Path    REG_EXPAND_SZ    C:\Program Files\thing` keeps
/// `C:\Program Files\thing`.
#[cfg(windows)]
pub(crate) fn reg_path_value(stdout: &str) -> Option<(String, String)> {
    let line = stdout
        .lines()
        .find(|line| line.trim_start().starts_with("Path"))?;
    for kind in ["REG_EXPAND_SZ", "REG_SZ"] {
        if let Some(at) = line.find(kind) {
            let value = line[at + kind.len()..].trim().to_string();
            return Some((kind.to_string(), value));
        }
    }
    None
}

/// The PATH with `dir` in it — `None` when the directory is already there.
///
/// The comparison is the same one Windows makes when it reads PATH: the
/// entries are separated by `;`, a trailing backslash is not a difference,
/// and the case is not a difference either.
#[cfg(windows)]
pub(crate) fn path_with_dir(value: &str, dir: &str) -> Option<String> {
    let needle = dir.trim().trim_end_matches('\\').to_lowercase();
    let already = value
        .split(';')
        .any(|part| part.trim().trim_end_matches('\\').to_lowercase() == needle);
    if already {
        return None;
    }
    let trimmed = value.trim().trim_end_matches(';');
    if trimmed.is_empty() {
        return Some(dir.to_string());
    }
    Some(format!("{trimmed};{dir}"))
}

/// Write the CLI shim. The tray item is the consent: nothing is written
/// until somebody asks for it.
pub(crate) fn install_cli_shim<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> Result<PathBuf, String> {
    let exe = std::env::current_exe().map_err(|err| err.to_string())?;
    let exe_dir = exe
        .parent()
        .ok_or_else(|| "no executable directory".to_string())?
        .to_path_buf();
    let resource_dir = app.path().resource_dir().ok();
    let node = find_node(&exe_dir, resource_dir.as_deref())
        .ok_or_else(|| "the app's own Node is not beside it".to_string())?;
    let cli = {
        // The CLI is named through the STABLE link, not through a versioned
        // directory: a content update promotes a new tree, and a shim that
        // named the old path would keep running yesterday's code while the
        // window runs today's. The link is made by the Node side
        // (`harness/app-root.mjs`), which can make a junction on Windows
        // without an administrator; the bundle is the fallback for a
        // machine whose backend never came up.
        let linked = cli_link().join("aipass-bridge").join("bin").join("aipass.mjs");
        if linked.exists() {
            linked
        } else {
            app.path()
                .resolve("aipass-bridge/bin/aipass.mjs", tauri::path::BaseDirectory::Resource)
                .map(plain)
                .map_err(|err| format!("the CLI is not in the bundle: {err}"))?
        }
    };
    let shim = cli_shim_path();
    if let Some(parent) = shim.parent() {
        std::fs::create_dir_all(parent).map_err(|err| err.to_string())?;
    }
    std::fs::write(&shim, cli_shim_script(&node, &cli)).map_err(|err| err.to_string())?;
    #[cfg(not(windows))]
    make_executable(&shim)?;
    Ok(shim)
}

/// A shim nobody can run is not a shim.
#[cfg(not(windows))]
pub(crate) fn make_executable(path: &std::path::Path) -> Result<(), String> {
    use std::os::unix::fs::PermissionsExt;
    let mut permissions = std::fs::metadata(path)
        .map_err(|err| err.to_string())?
        .permissions();
    permissions.set_mode(0o755);
    std::fs::set_permissions(path, permissions).map_err(|err| err.to_string())
}
