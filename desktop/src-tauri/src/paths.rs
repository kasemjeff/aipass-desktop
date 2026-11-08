//! Where the app finds the files it runs.
//!
//! The content overlay, the packaged resources, the repository walk-up,
//! the Node sidecar, the per-user home, the install command the backend
//! leaves for the shell, and the content-tree rollback. The Node side
//! implements the same root rule (harness/app-root.mjs) because the two
//! cannot import each other; a test says they agree.

use std::path::PathBuf;
use std::process::Command;

use tauri::Manager;

use crate::processes::note;

pub(crate) const MARKER: &str = crate::shared::APP_MARKER;

/// The command the backend leaves for the shell.
///
/// The backend cannot replace the app's own binary — it is the child of it,
/// and the app is what has to be closed for the installer to do its work. So
/// the backend writes a command and the shell, which outlives it, reads it.
pub(crate) struct InstallCommand {
    pub(crate) version: String,
    /// A NAME, not a path. The shell builds the path itself, from its own
    /// downloads directory, so a command file cannot make the app run
    /// anything anywhere else.
    pub(crate) file: String,
    pub(crate) sha256: String,
}

/// The artifact's SHA-256, computed by the app's own Node.
///
/// The shell has no SHA-256 of its own and the repository carries no
/// dependencies — but the app SHIPS a Node, and `node:crypto` is a builtin.
/// So the hash is computed by the same runtime that runs the harness, and
/// the script is written beside the app's own state and taken away again.
pub(crate) fn hash_with_node(node: &str, artifact: &std::path::Path, home: &std::path::Path) -> Option<String> {
    let script = home.join("app").join("verify-sha256.mjs");
    let code = "import crypto from 'node:crypto';\nimport fs from 'node:fs';\nconst h = crypto.createHash('sha256');\nh.update(fs.readFileSync(process.argv[2]));\nprocess.stdout.write(h.digest('hex'));\n";
    std::fs::create_dir_all(home.join("app")).ok()?;
    std::fs::write(&script, code).ok()?;
    let out = Command::new(node).arg(&script).arg(artifact).output().ok();
    let _ = std::fs::remove_file(&script);
    let out = out?;
    if !out.status.success() {
        return None;
    }
    let text = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if text.len() == 64 {
        Some(text)
    } else {
        None
    }
}

/// Read the handover command, if the backend left one.
///
/// A name that carries a path separator or a `..` is refused: the command
/// names a file, it does not choose one.
pub(crate) fn read_install_command(home: &std::path::Path) -> Option<InstallCommand> {
    let file = home.join("app").join("commands").join("install.json");
    let text = std::fs::read_to_string(&file).ok()?;
    let json: serde_json::Value = serde_json::from_str(&text).ok()?;
    let version = json.get("version")?.as_str()?.to_string();
    let name = json.get("file")?.as_str()?.to_string();
    if name.is_empty()
        || name.contains('/')
        || name.contains('\\')
        || name.contains("..")
        || name.contains(':')
    {
        return None;
    }
    let sha256 = json.get("sha256")?.as_str()?.to_string();
    // A value that is not a SHA-256 hex digest describes nothing: the
    // handover compares it byte for byte against the artifact's real digest,
    // so a malformed one could only ever fail late. Refuse it at the door.
    if sha256.len() != 64 || !sha256.chars().all(|c| c.is_ascii_hexdigit()) {
        return None;
    }
    Some(InstallCommand {
        version,
        file: name,
        sha256,
    })
}

/// Where the command lives, and where the artifact it names does.
pub(crate) fn command_paths(home: &std::path::Path) -> (std::path::PathBuf, std::path::PathBuf) {
    (
        home.join("app").join("commands").join("install.json"),
        home.join("app").join("downloads"),
    )
}

/// The plain form of a path.
///
/// Windows hands back the long-path form (`\\?\C:\…`) for anything the
/// resource resolver produces, and Node cannot run one: it reads the prefix
/// as a directory and the backend dies with `lstat 'C:'`. The prefix is
/// Windows' way of saying "this path may be longer than 260 characters", and
/// the plain form says the same thing to everything else.
pub(crate) fn plain(path: PathBuf) -> PathBuf {
    let text = path.to_string_lossy().to_string();
    match text.strip_prefix(r"\\?\") {
        // A UNC path keeps its two leading slashes: `\\?\UNC\server\share`
        // is `\\server\share`.
        Some(rest) if rest.starts_with(r"UNC\") => PathBuf::from(format!(r"\\{}", &rest[4..])),
        Some(rest) => PathBuf::from(rest),
        None => path,
    }
}

/// Where the app finds the files it runs.
///
/// The candidates, in the order they are tried:
///
///   1. the CONTENT OVERLAY — a promoted content tree under
///      `~/.aipass/app/`, put there by the update system from a pack whose
///      hash is in a signed feed. It is not a checkout: it is the newest
///      thing a person deliberately chose, and the only candidate here that
///      was checked against a signature.
///   2. the packaged resource dir — an installed build.
///   3. the binary's own directory — some installers relocate these.
///   4. the repository, walking up — `tauri dev` from target/debug.
///
/// The installed build comes before the repository for the reason the old
/// comment gave: an app that runs the *repository's* files when a checkout
/// happens to sit on the same machine is not the build that was installed,
/// and the difference shows up as a bug that only the person who made the
/// build can see.
///
/// The Node side implements the same rule (`harness/app-root.mjs`), because
/// the two cannot import each other. A test says they agree.
pub(crate) fn root_candidates(app: &tauri::App, exe_dir: &std::path::Path) -> Vec<(PathBuf, &'static str)> {
    let mut candidates: Vec<(PathBuf, &'static str)> = Vec::new();

    // The overlay comes first: it is a verified release of the content.
    if let Some(root) = overlay_root_in(&aipass_home()) {
        candidates.push((root, "overlay"));
    }
    // The resource dir is the install dir on Windows and `Contents/Resources`
    // on macOS; the marker sits three levels under it (aipass-bridge/bridge/
    // server.mjs), so the root is three parents up.
    if let Ok(res) = app.path().resolve(MARKER, tauri::path::BaseDirectory::Resource) {
        if let Some(root) = plain(res)
            .parent()
            .and_then(|p| p.parent())
            .and_then(|p| p.parent())
        {
            candidates.push((root.to_path_buf(), "bundle"));
        }
    }
    // Next to the binary: where the bundler puts a sidecar and, on some
    // layouts, the resources too.
    candidates.push((exe_dir.to_path_buf(), "bundle"));
    // The repo, from where this crate was compiled — what `tauri dev` needs.
    if let Some(tauri_dir) = PathBuf::from(env!("AIPASS_TAURI_DIR")).parent().and_then(|p| p.parent()) {
        candidates.push((tauri_dir.to_path_buf(), "repo"));
    }
    let mut up = exe_dir.to_path_buf();
    for _ in 0..6 {
        if let Some(parent) = up.parent() {
            up = parent.to_path_buf();
            candidates.push((up.clone(), "repo"));
        }
    }
    candidates
}

/// The first candidate that is really an app root.
///
/// The root is resolved on every spawn, not once at startup: a content
/// update promotes a new tree, and the backend that runs it has to be
/// started from there.
pub(crate) fn pick_root(candidates: &[(PathBuf, &'static str)]) -> (PathBuf, &'static str) {
    for (root, source) in candidates {
        if root.join(MARKER).exists() {
            return (root.clone(), *source);
        }
    }
    (
        candidates.first().map(|c| c.0.clone()).unwrap_or_default(),
        "none",
    )
}

/// The content overlay: the promoted content tree, if one is active.
///
/// `~/.aipass/app/active.json` names it. A pointer that names a directory
/// without the marker in it is ignored — a half-written pointer must not
/// send the app looking for files that are not there.
///
/// The lookup is split so a test can name a home without touching the real
/// one.
pub(crate) fn overlay_root_in(home: &std::path::Path) -> Option<PathBuf> {
    let active = home.join("app").join("active.json");
    let text = std::fs::read_to_string(&active).ok()?;
    let json: serde_json::Value = serde_json::from_str(&text).ok()?;
    let root = json.get("current")?.get("root")?.as_str()?;
    let root = PathBuf::from(root);
    if root.join(MARKER).exists() {
        Some(root)
    } else {
        None
    }
}

/// Node runs everything: the packaged build ships it as a sidecar beside the
/// binary (Tauri's externalBin naming), a source checkout finds it on PATH.
/// The sidecar names are per-platform, because Tauri builds one target triple
/// per machine and names the external binary after it.
#[cfg(windows)]
pub(crate) const NODE_SIDECAR_NAMES: &[&str] = &["node-x86_64-pc-windows-msvc.exe", "node.exe"];
#[cfg(not(windows))]
pub(crate) const NODE_SIDECAR_NAMES: &[&str] = &[
    "node-aarch64-apple-darwin",
    "node-x86_64-apple-darwin",
    "node-aarch64-unknown-linux-gnu",
    "node-x86_64-unknown-linux-gnu",
    "node",
];

pub(crate) fn node_path(exe_dir: &std::path::Path, resource_dir: Option<&std::path::Path>) -> String {
    find_node(exe_dir, resource_dir)
        .map(|path| path.to_string_lossy().to_string())
        .unwrap_or_else(|| "node".to_string())
}

/// The app's own Node, if the bundle carries it.
///
/// Two places to look: next to the binary (where the bundler puts a sidecar
/// on Windows and macOS) and in the resource directory (where some layouts
/// put it). A source checkout has neither and finds Node on PATH.
pub(crate) fn find_node(exe_dir: &std::path::Path, resource_dir: Option<&std::path::Path>) -> Option<PathBuf> {
    for dir in [Some(exe_dir), resource_dir].into_iter().flatten() {
        for name in NODE_SIDECAR_NAMES {
            let sidecar = dir.join(name);
            if sidecar.exists() {
                return Some(sidecar);
            }
        }
    }
    None
}

/// The `.aipass` directory: the override, or `<home>/.aipass`.
///
/// The Node side reads `AIPASS_HOME` as the `.aipass` directory itself
/// (`harness/settings.mjs`), so the shell reads it the same way — one
/// override, one meaning, on every platform. A run that points it at a
/// scratch directory (the install ladder does) then keeps the real home
/// untouched, log included.
pub(crate) fn aipass_home() -> PathBuf {
    match std::env::var("AIPASS_HOME") {
        Ok(dir) if !dir.trim().is_empty() => PathBuf::from(dir),
        _ => home_dir().join(crate::shared::APP_HOME_DIR),
    }
}

/// `~/.aipass/settings.json` → { "root": "C:\\…" } — the same file the window
/// writes when a project is switched, so the packaged app opens where the last
/// session left off. `desktop.json` is the pre-unification leftover: when it
/// is the only file that names a root, its value is migrated into
/// settings.json once, so the two files can never disagree again.
pub(crate) fn last_root() -> Option<PathBuf> {
    match std::env::var("AIPASS_HOME") {
        Ok(dir) if !dir.trim().is_empty() => last_root_in_aipass(&PathBuf::from(dir)),
        _ => last_root_in(&home_dir()),
    }
}

/// The same lookup, against a named home — so the migration can be tested
/// without touching the real one.
pub(crate) fn last_root_in(dir: &std::path::Path) -> Option<PathBuf> {
    last_root_in_aipass(&dir.join(crate::shared::APP_HOME_DIR))
}

/// The same lookup, against the `.aipass` directory itself — the shape the
/// `AIPASS_HOME` override names.
pub(crate) fn last_root_in_aipass(dir: &std::path::Path) -> Option<PathBuf> {
    let settings_path = dir.join("settings.json");
    if let Ok(text) = std::fs::read_to_string(&settings_path) {
        if let Ok(json) = serde_json::from_str::<serde_json::Value>(&text) {
            if let Some(root) = json.get("root").and_then(|v| v.as_str()) {
                let path = PathBuf::from(root);
                if path.exists() {
                    return Some(path);
                }
            }
        }
    }
    // One-way migration from the legacy file. A root that no longer exists
    // migrates nowhere — settings.json keeps no dead path.
    let legacy = dir.join("desktop.json");
    if let Ok(text) = std::fs::read_to_string(&legacy) {
        if let Ok(json) = serde_json::from_str::<serde_json::Value>(&text) {
            if let Some(root) = json.get("root").and_then(|v| v.as_str()) {
                let path = PathBuf::from(root);
                if path.exists() {
                    // The settings file is MERGED, never replaced. It holds the
                    // mode, the model, the compaction budget, the path rules and
                    // the project list; a migration that wrote {"root":…} over
                    // it took all of that with it. Only the root changes here.
                    let mut merged = std::fs::read_to_string(&settings_path)
                        .ok()
                        .and_then(|t| serde_json::from_str::<serde_json::Value>(&t).ok())
                        .filter(|v| v.is_object())
                        .unwrap_or_else(|| serde_json::json!({}));
                    merged["root"] = serde_json::Value::String(root.to_string());
                    let written =
                        std::fs::write(&settings_path, serde_json::to_string_pretty(&merged).unwrap_or_default());
                    // The legacy file goes only after the write landed: a
                    // failed write must not take the only copy of the root
                    // with it.
                    if written.is_ok() {
                        let _ = std::fs::remove_file(&legacy);
                    }
                    return Some(path);
                }
            }
        }
    }
    None
}

/// The home directory, whichever machine this is: `$HOME` on unix,
/// `%USERPROFILE%` on Windows. Both are where `~/.aipass` lives.
pub(crate) fn home_dir() -> PathBuf {
    let var = if cfg!(windows) { "USERPROFILE" } else { "HOME" };
    std::env::var(var)
        .map(PathBuf::from)
        .unwrap_or_else(|_| PathBuf::from("."))
}

/// Write a file by the atomic route: a temp name beside it, then a rename.
///
/// The rename replaces the destination on both platforms, so a crash leaves
/// either the old bytes or the new ones — never half of each. The Node side
/// has the same rule in `harness/atomic-write.mjs`.
pub(crate) fn write_atomic(file: &std::path::Path, text: &str) -> std::io::Result<()> {
    let tmp = file.with_extension("json.tmp");
    std::fs::write(&tmp, text)?;
    std::fs::rename(&tmp, file)
}

/// Put the previous content tree back, when a promotion is what broke the app.
///
/// The shape that calls for it: the backend died three times in a row, and
/// the content was promoted recently. The previous tree is still on disk, so
/// the app heals itself instead of sitting there unable to start — which is
/// the difference between a bad release costing one restart and costing the
/// person their app.
///
/// A tree promoted long ago is not what broke just now, so the promotion has
/// to be recent for this to fire.
pub(crate) fn roll_content_back() -> bool {
    roll_content_back_in(&aipass_home())
}

/// The same, against a named home — so a test can drive it.
pub(crate) fn roll_content_back_in(home: &std::path::Path) -> bool {
    let active = home.join("app").join("active.json");
    let Ok(text) = std::fs::read_to_string(&active) else {
        return false;
    };
    let Ok(mut json) = serde_json::from_str::<serde_json::Value>(&text) else {
        return false;
    };
    let Some(previous) = json.get("previous").cloned() else {
        return false;
    };
    if previous.is_null() {
        return false;
    }
    let Some(root) = previous.get("root").and_then(|v| v.as_str()) else {
        return false;
    };
    let root = PathBuf::from(root);
    if !root.join(MARKER).exists() {
        return false;
    }
    let updated = json.get("updatedAt").and_then(|v| v.as_u64()).unwrap_or(0);
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);
    if now.saturating_sub(updated) > 10 * 60 * 1000 {
        return false;
    }
    let broken = json.get("current").cloned();
    json["current"] = previous;
    json["previous"] = broken.unwrap_or(serde_json::Value::Null);
    json["updatedAt"] = serde_json::Value::from(now);
    let Ok(written) = serde_json::to_string_pretty(&json) else {
        return false;
    };
    if write_atomic(&active, &written).is_err() {
        return false;
    }
    note("the content tree broke the backend three times in a row — the previous one is back");
    true
}
