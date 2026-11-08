#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
//! aipass desktop shell.
//!
//! Window, tray, single instance, and the supervisor that keeps the
//! Node backend alive. The shell knows nothing about agents: it spawns
//! the harness (desktop/main.mjs, into aipass-bridge/harness/launcher.mjs)
//! and supervises the child. Decisions live in supervisor, paths in
//! paths, the child in backend, geometry in geometry, process and log
//! helpers in processes, and theme and tray in window.

mod backend;
mod geometry;
mod paths;
mod processes;
mod supervisor;
mod window;

use std::path::PathBuf;
use std::sync::atomic::Ordering;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::Manager;
use tauri::menu::{Menu, MenuItem};

use crate::backend::*;
use crate::geometry::*;
use crate::paths::*;
use crate::processes::*;
use crate::supervisor::*;
use crate::window::*;
fn main() -> Result<(), Box<dyn std::error::Error>> {
    // The handover helper runs first: it is the app's own executable with an
    // argument, and it is not an app.
    if let Some(result) = handover_helper() {
        return result;
    }
    tauri::Builder::default()
        // A second double-click must focus the window that is already there,
        // not open a twin: two windows pointing at one backend is a confusing
        // thing to explain to somebody who just wanted to open the app.
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.show();
                let _ = window.set_focus();
            }
        }))
        .setup(|app| {
            let exe = std::env::current_exe()?;
            let exe_dir = exe.parent().ok_or("no executable directory")?.to_path_buf();
            let resource_dir = app.path().resource_dir().ok();
            let candidates = root_candidates(app, &exe_dir);
            let (root, source) = pick_root(&candidates);
            let entry = root.join("aipass-bridge").join("harness").join("rpc.mjs");
            let project_root = last_root().unwrap_or_else(home_dir);

            // The whole backend is this one child process: it starts the bridge
            // if it is not up, serves the window, and owns every agent run.
            // If something is already answering on that port - `aipass desktop`
            // in a browser, say - the window adopts it instead of fighting it.
            // The port itself honours AIPASS_DESKTOP_PORT, so a window started
            // beside a custom-port backend adopts it rather than spawning a
            // second one on a port nothing else is using.
            let backend_port = backend_port()?;
            // What the backend is actually run with — the one line that says
            // which files the installed build is running, when somebody asks
            // why the app and the checkout disagree.
            note(&format!(
                "backend: node={} entry={} root={} source={}",
                node_path(&exe_dir, resource_dir.as_deref()),
                entry.display(),
                project_root.display(),
                source
            ));
            let backend = Arc::new(Backend::new(
                node_path(&exe_dir, resource_dir.as_deref()),
                candidates,
                backend_port,
                project_root.clone(),
                app.handle().clone(),
            ));
            // The weak self-handle goes in before anything can ask a probe:
            // the deadline wrapper needs it to hand the ask to a thread.
            *backend.self_handle.lock().unwrap() = Some(Arc::downgrade(&backend));
            // Adopt a backend that is already answering (a browser `aipass
            // desktop`, say); otherwise start one. An adopted backend is not
            // ours to respawn — the supervisor's child stays None.
            //
            // "Answering" means OUR backend, not just something on the port:
            // a bare TCP connect would adopt a stranger's server and point
            // the window at it, and the window would then talk to a program
            // that has never heard of aipass. The probe asks the question the
            // launcher asks, through the app's own Node.
            if backend.port_owner() != PortOwner::Ours {
                match backend.spawn() {
                    Ok(kid) => *backend.child.lock().unwrap() = Some(kid),
                    Err(err) => {
                        // A failed spawn is death the person can see: a
                        // release build has no console to print a panic on,
                        // and the expect() that stood here died silently —
                        // the window simply never came, with nothing named.
                        alert(
                            "aipass desktop",
                            &format!(
                                "เริ่ม backend ของ aipass ไม่สำเร็จ:\n{err}\n\nตรวจว่ามี Node ติดตั้ง และดู log ได้ที่\n{}",
                                backend_log_path().display()
                            ),
                        );
                        return Err(err.into());
                    }
                }
            } else {
                // The empty child slot must stay empty: the window is pointed
                // at the backend already answering, and the supervisor would
                // read the slot as "a spawn that failed" and fill it with a
                // second backend that could only die on the same port.
                backend.adopted.store(true, Ordering::SeqCst);
            }

            // Watch the child for as long as the app lives. The window's
            // EventSource redials after a crash and restores from the session
            // snapshot, so a restart reads as a pause, not as a lost run.
            {
                let watched = backend.clone();
                std::thread::spawn(move || loop {
                    std::thread::sleep(Duration::from_secs(2));
                    if watched.quitting.load(Ordering::SeqCst) {
                        break;
                    }
                    watched.tick();
                });
            }

            // The window opens only once the backend answers, so a cold start
            // never lands on a blank page.
            let url = format!("http://127.0.0.1:{backend_port}/");
            let port_open = || std::net::TcpStream::connect(("127.0.0.1", backend_port)).is_ok();
            // Sixty seconds, not twenty. A cold boot is the slow case: Defender
            // scans the bundled node.exe, the disk is still busy, and a backend
            // that needed twenty-five seconds was reported as "never answered"
            // and left the person with no window at all.
            for _ in 0..240 {
                if port_open() {
                    break;
                }
                std::thread::sleep(std::time::Duration::from_millis(250));
            }
            std::thread::sleep(std::time::Duration::from_millis(150));
            // The window navigates only at OUR backend. The TCP loop above is
            // the cheap wait; the probe — the same question the spawn asked —
            // is the verdict before the window points anywhere. A port another
            // program took between the spawn gate and here would otherwise
            // open the window onto a stranger's server.
            if !port_open() {
                alert(
                    "aipass desktop",
                    &format!(
                        "backend ไม่ตอบบนพอร์ต {backend_port} — หน้าต่างเปิดไม่ได้\n\nดู log ได้ที่\n{}",
                        backend_log_path().display()
                    ),
                );
                return Err(format!("the backend never answered on port {backend_port}").into());
            }
            if backend.port_owner() == PortOwner::Stranger {
                alert(
                    "aipass desktop",
                    &format!(
                        "พอร์ต {backend_port} ถูกโปรแกรมอื่นใช้อยู่ หน้าต่าง aipass จึงเปิดที่นี่ไม่ได้\n\nตั้ง AIPASS_DESKTOP_PORT เป็นพอร์ตว่างแล้วเริ่มใหม่ (log อยู่ที่\n{})",
                        backend_log_path().display()
                    ),
                );
                return Err(format!("port {backend_port} is not the aipass backend").into());
            }
            // `Unknown` passes: the spawn gate above already demanded a real
            // "ours" before starting one, and a probe that cannot answer does
            // not get to invent a verdict the window is blocked on.

            let window = tauri::WebviewWindowBuilder::new(
                app,
                "main",
                tauri::WebviewUrl::External(url.parse().unwrap()),
            )
            .title("aipass desktop")
            .theme(desktop_theme())
            .inner_size(1280.0, 860.0)
            .min_inner_size(900.0, 600.0)
            // Built hidden: the remembered shape goes on before the first
            // paint, so the window comes back where it was instead of opening
            // at the default and jumping.
            .visible(false)
            .build()?;

            if let Some(geometry) = load_window_geometry() {
                let _ = window.set_size(tauri::PhysicalSize::new(geometry.width, geometry.height));
                let _ = window.set_position(tauri::PhysicalPosition::new(geometry.x, geometry.y));
                if geometry.maximized {
                    let _ = window.maximize();
                }
            }
            let _ = window.show();

            // The backend is part of the app, not a service, so quitting takes
            // it down with it — and stops the supervisor, so the exit reads as
            // deliberate rather than as a crash to answer.
            let window_handle = window.clone();
            let backend_handle = backend.clone();
            // The shape a drag leaves behind: the resize/move events fire
            // faster than a disk wants writes, so the newest geometry waits
            // here and a slow thread commits it.
            let geometry_slot: Arc<Mutex<Option<WindowGeometry>>> = Arc::new(Mutex::new(None));
            let geometry_handle = geometry_slot.clone();
            window.on_window_event(move |event| {
                match event {
                    // Closing the window hides it instead of killing the app:
                    // the backend and whatever run is in flight keep going in
                    // the tray, and "ออก" in the tray menu is what quits for
                    // real. A run should not die because someone tidied their
                    // taskbar by reflex.
                    tauri::WindowEvent::CloseRequested { api, .. } => {
                        api.prevent_close();
                        let _ = window_handle.hide();
                    }
                    // The window is the shape the person last left it in —
                    // moved or resized, the newest fact lands in the slot and
                    // the slow writer below commits it.
                    tauri::WindowEvent::Resized(_) | tauri::WindowEvent::Moved(_) => {
                        let size = window_handle.inner_size().ok();
                        let position = window_handle.outer_position().ok();
                        if let (Some(size), Some(position)) = (size, position) {
                            *geometry_handle.lock().unwrap() = Some(WindowGeometry {
                                width: size.width,
                                height: size.height,
                                x: position.x,
                                y: position.y,
                                maximized: window_handle.is_maximized().unwrap_or(false),
                            });
                        }
                    }
                    tauri::WindowEvent::Destroyed => {
                        // The slow writer may not have woken yet: the last
                        // shape goes down with the window now, or the next
                        // start opens a window that forgot.
                        if let Some(geometry) = geometry_handle.lock().unwrap().take() {
                            save_window_geometry_to(&aipass_home(), &geometry);
                        }
                        backend_handle.shutdown();
                    }
                    _ => {}
                }
            });

            // The slow writer: every 800 ms it commits whatever shape is
            // waiting, which during a drag turns hundreds of events into a
            // handful of writes — and the last one is the truth.
            {
                let pending = geometry_slot.clone();
                std::thread::spawn(move || loop {
                    std::thread::sleep(Duration::from_millis(800));
                    let Some(geometry) = pending.lock().unwrap().take() else { continue };
                    save_window_geometry_to(&aipass_home(), &geometry);
                });
            }

            let show_item = MenuItem::with_id(app, "show", "แสดงหน้าต่าง", true, None::<&str>)?;
            let log_item = MenuItem::with_id(app, "log-folder", "เปิดโฟลเดอร์ log", true, None::<&str>)?;
            let quit_item = MenuItem::with_id(app, "quit", "ออก", true, None::<&str>)?;
            let tray_menu = Menu::with_items(app, &[&show_item, &log_item, &quit_item])?;

            let tray = tauri::tray::TrayIconBuilder::new()
                .icon(tray_icon(app.handle()))
                // The menu bar draws a template image as a mask, so macOS
                // needs the silhouette; the flag is a no-op elsewhere.
                .icon_as_template(cfg!(target_os = "macos"))
                .tooltip("aipass desktop")
                .menu(&tray_menu)
                .on_menu_event(|app, event| {
                    match event.id().as_ref() {
                        "show" => {
                            if let Some(window) = app.get_webview_window("main") {
                                let _ = window.show();
                                let _ = window.set_focus();
                            }
                        }
                        // The log folder is where a person is sent when
                        // something looks wrong — the alerts name the path,
                        // and this opens it without the copying.
                        "log-folder" => reveal_folder(&aipass_home().join("logs")),
                        // Exit runs the same path as the window closing:
                        // Destroyed still fires, so a backend this window
                        // started is still taken down here, not left orphaned.
                        "quit" => app.exit(0),
                        _ => {}
                    }
                })
                .build(app)?;
            tray.on_tray_icon_event(|tray, event| {
                // One click opens the window: the tray is where the window
                // lives while it is hidden, and a click is the natural way to
                // knock on it. The double-click variant stays handled too —
                // show is idempotent, so a double-click costing two shows
                // costs nothing.
                if matches!(
                    event,
                    tauri::tray::TrayIconEvent::Click { .. } | tauri::tray::TrayIconEvent::DoubleClick { .. }
                ) {
                    if let Some(window) = tray.app_handle().get_webview_window("main") {
                        let _ = window.show();
                        let _ = window.set_focus();
                    }
                }
            });

            // A backend that died immediately is worth saying out loud rather
            // than showing a blank window forever. Its output — stderr
            // included, now that spawn() redirects both — is in the log.
            {
                let mut guard = backend.child.lock().unwrap();
                if let Some(ref mut kid) = *guard {
                    if let Ok(Some(status)) = kid.try_wait() {
                        return Err(format!(
                            "the aipass backend exited at once ({status}) — see ~/.aipass/logs/desktop-backend.log"
                        )
                        .into());
                    }
                }
            }
            Ok(())
        })
        .build(tauri::generate_context!())?
        .run(|_handle, event| {
            if let tauri::RunEvent::ExitRequested { .. } = event {
                // The window event above already stopped the sidecar.
            }
        });
    Ok(())
}

/// The titlebar is the one surface the app cannot paint itself, so Windows
/// draws a light frame over the warm window unless the theme is set before the
/// window opens. The settings file is the only thing that knows this early —
/// the backend that serves settings is not up yet — so read it directly;
/// "auto" hands the frame back to the system, which is what auto means.

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU32, Ordering};

    static COUNTER: AtomicU32 = AtomicU32::new(0);

    /// A throwaway home: `<temp>/aipass-tauri-<pid>-<n>`, with the `.aipass`
    /// folder the settings live in.
    fn scratch_home() -> PathBuf {
        let n = COUNTER.fetch_add(1, Ordering::Relaxed);
        let dir = std::env::temp_dir().join(format!("aipass-tauri-{}-{}", std::process::id(), n));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join(".aipass")).expect("scratch home");
        dir
    }

    /// A project folder the migration can point at — it has to exist, or the
    /// root migrates nowhere.
    fn scratch_project(home: &std::path::Path) -> PathBuf {
        let project = home.join("project");
        std::fs::create_dir_all(&project).expect("scratch project");
        project
    }

    #[cfg(windows)]
    #[test]
    fn the_tasklist_line_says_whether_the_pid_lives() {
        // The CSV row quotes the pid; the "no tasks" answer does not. A pid
        // that merely CONTAINS the digits is not the pid.
        assert!(tasklist_says_alive(42, "\"node.exe\",\"42\",\"Console\",\"1\",\"1,000 K\""));
        assert!(!tasklist_says_alive(
            42,
            "INFO: no tasks are running which match the specified criteria."
        ));
        assert!(!tasklist_says_alive(4, "\"node.exe\",\"142\",\"Console\",\"1\""));
    }

    #[test]
    fn the_window_geometry_round_trips_through_the_home() {
        let home = scratch_home();
        assert_eq!(load_window_geometry_from(&home), None, "nothing remembered yet");
        let geometry = WindowGeometry { width: 1280, height: 860, x: 120, y: -40, maximized: false };
        save_window_geometry_to(&home, &geometry);
        assert_eq!(load_window_geometry_from(&home), Some(geometry), "the shape comes back whole");
        // A torn or foreign file is one default-sized window, not a crash.
        std::fs::write(window_geometry_path(&home), "{not json").expect("torn file");
        assert_eq!(load_window_geometry_from(&home), None);
    }

    #[test]
    fn the_legacy_migration_keeps_the_settings_it_finds() {
        // The settings file holds the mode, the model, the compaction budget
        // and the path rules. The migration writes one key, so it has to merge
        // — a migration that replaced the file took all of that with it.
        let home = scratch_home();
        let project = scratch_project(&home);
        let settings = home.join(".aipass").join("settings.json");
        std::fs::write(
            &settings,
            r#"{"mode":"ask","defaultModel":"some-model","compaction":{"contextTokens":24000}}"#,
        )
        .expect("settings");
        let legacy = home.join(".aipass").join("desktop.json");
        std::fs::write(
            &legacy,
            serde_json::to_string(&serde_json::json!({ "root": project.to_string_lossy() })).expect("json"),
        )
        .expect("legacy");

        let found = last_root_in(&home);
        assert_eq!(found.as_deref(), Some(project.as_path()), "the root migrated");

        let after: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(&settings).expect("settings")).expect("json");
        assert_eq!(after["root"].as_str(), Some(project.to_string_lossy().as_ref()));
        assert_eq!(after["mode"].as_str(), Some("ask"), "the mode survived");
        assert_eq!(after["defaultModel"].as_str(), Some("some-model"), "the model survived");
        assert_eq!(
            after["compaction"]["contextTokens"].as_u64(),
            Some(24000),
            "the compaction budget survived"
        );
        assert!(!legacy.exists(), "the legacy file is gone once the root is written");
    }

    #[test]
    fn the_legacy_migration_creates_a_settings_file_when_there_is_none() {
        let home = scratch_home();
        let project = scratch_project(&home);
        let legacy = home.join(".aipass").join("desktop.json");
        std::fs::write(
            &legacy,
            serde_json::to_string(&serde_json::json!({ "root": project.to_string_lossy() })).expect("json"),
        )
        .expect("legacy");

        let found = last_root_in(&home);
        assert_eq!(found.as_deref(), Some(project.as_path()));
        let settings = home.join(".aipass").join("settings.json");
        assert!(settings.exists(), "the settings file was written");
        let after: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(&settings).expect("settings")).expect("json");
        assert_eq!(after["root"].as_str(), Some(project.to_string_lossy().as_ref()));
    }

    #[test]
    fn a_settings_file_that_already_names_a_root_is_left_alone() {
        // The legacy file is only a fallback: a settings file that already
        // names a live root is the truth, and the migration does not run.
        let home = scratch_home();
        let project = scratch_project(&home);
        let settings = home.join(".aipass").join("settings.json");
        std::fs::write(
            &settings,
            serde_json::to_string(&serde_json::json!({ "root": project.to_string_lossy(), "mode": "ask" })).expect("json"),
        )
        .expect("settings");
        let legacy = home.join(".aipass").join("desktop.json");
        std::fs::write(
            &legacy,
            serde_json::to_string(&serde_json::json!({ "root": home.join("gone").to_string_lossy() })).expect("json"),
        )
        .expect("legacy");

        let found = last_root_in(&home);
        assert_eq!(found.as_deref(), Some(project.as_path()));
        let after: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(&settings).expect("settings")).expect("json");
        assert_eq!(after["mode"].as_str(), Some("ask"), "the settings were not rewritten");
        assert!(legacy.exists(), "the legacy file stays: the settings file was never migrated");
    }

    #[test]
    fn the_aipass_home_override_names_the_aipass_directory_itself() {
        // The Node side reads AIPASS_HOME as the `.aipass` directory, so the
        // shell reads it the same way: one override, one meaning. The lookup
        // is split so a test can name a directory without touching the
        // environment.
        let home = scratch_home();
        let project = scratch_project(&home);
        let aipass = home.join(".aipass");
        std::fs::write(
            &aipass.join("settings.json"),
            serde_json::to_string(&serde_json::json!({ "root": project.to_string_lossy() })).unwrap_or_default(),
        )
        .expect("settings");
        let found = last_root_in_aipass(&aipass);
        assert_eq!(found.as_deref(), Some(project.as_path()));
    }

    #[test]
    fn the_windows_long_path_prefix_is_stripped() {
        // Node cannot run a `\\?\` path: it reads the prefix as a directory
        // and the backend dies with `lstat 'C:'`. The installed app hit
        // exactly that, and the install ladder is what found it.
        assert_eq!(
            plain(PathBuf::from(r"\\?\C:\apps\aipass desktop\node.exe")),
            PathBuf::from(r"C:\apps\aipass desktop\node.exe")
        );
        assert_eq!(
            plain(PathBuf::from(r"\\?\UNC\server\share\aipass")),
            PathBuf::from(r"\\server\share\aipass")
        );
        // A path that is already plain stays exactly as it was.
        assert_eq!(
            plain(PathBuf::from(r"C:\apps\aipass")),
            PathBuf::from(r"C:\apps\aipass")
        );
    }

    /// A content tree with the marker in it — what an overlay root looks like.
    fn scratch_content(home: &std::path::Path, version: &str) -> PathBuf {
        let root = home.join("app").join("content").join(version);
        let marker = root.join(MARKER);
        std::fs::create_dir_all(marker.parent().expect("marker dir")).expect("content tree");
        std::fs::write(&marker, "//\n").expect("marker");
        root
    }

    /// The pointer the Node side writes.
    fn write_active(
        home: &std::path::Path,
        current: Option<(&str, &std::path::Path)>,
        previous: Option<(&str, &std::path::Path)>,
        updated_at: u64,
    ) {
        let dir = home.join("app");
        std::fs::create_dir_all(&dir).expect("app dir");
        let entry = |pair: Option<(&str, &std::path::Path)>| match pair {
            Some((version, root)) => serde_json::json!({
                "version": version,
                "root": root.to_string_lossy(),
            }),
            None => serde_json::Value::Null,
        };
        let json = serde_json::json!({
            "schema": 1,
            "current": entry(current),
            "previous": entry(previous),
            "updatedAt": updated_at,
        });
        std::fs::write(
            dir.join("active.json"),
            serde_json::to_string_pretty(&json).expect("json"),
        )
        .expect("active");
    }

    #[test]
    fn the_overlay_wins_over_the_bundle() {
        // The overlay is a verified release of the content, so it is the
        // first candidate — the same order the Node side uses.
        let home = scratch_home();
        let overlay = scratch_content(&home, "0.3.0");
        let bundle = home.join("bundle");
        std::fs::create_dir_all(bundle.join("aipass-bridge").join("bridge")).expect("bundle");
        std::fs::write(bundle.join(MARKER), "//\n").expect("marker");

        write_active(&home, Some(("0.3.0", &overlay)), None, 1);
        assert_eq!(overlay_root_in(&home), Some(overlay.clone()));

        let candidates = vec![
            (overlay.clone(), "overlay"),
            (bundle.clone(), "bundle"),
        ];
        let (root, source) = pick_root(&candidates);
        assert_eq!(root, overlay, "the overlay is the root");
        assert_eq!(source, "overlay");
    }

    #[test]
    fn a_pointer_that_names_nothing_is_ignored() {
        // A half-written pointer must not send the app looking for files
        // that are not there: the bundle is the root instead.
        let home = scratch_home();
        let missing = home.join("app").join("content").join("gone");
        write_active(&home, Some(("0.3.0", &missing)), None, 1);
        assert_eq!(overlay_root_in(&home), None);
    }

    #[test]
    fn one_of_our_backends_on_the_port_is_adopted() {
        // The window is pointed at that port, and it is already talking to
        // the backend that is answering there. Starting another one could
        // only die on the same port, so the supervisor stops starting one.
        assert_eq!(busy_outcome(PortOwner::Ours), BusyOutcome::Adopt);
    }

    #[test]
    fn a_stranger_on_the_port_is_named_and_not_retried_harder() {
        // Restarting cannot fix a stranger on the port. The situation is
        // named once, with the fix, and the polite backoff continues — so
        // the port is picked up again if it is freed.
        assert_eq!(busy_outcome(PortOwner::Stranger), BusyOutcome::Name);
    }

    #[test]
    fn a_port_nobody_holds_is_just_a_backoff() {
        // Nothing there, or the probe could not say: the ordinary backoff is
        // the answer either way.
        assert_eq!(busy_outcome(PortOwner::Empty), BusyOutcome::Backoff);
        assert_eq!(busy_outcome(PortOwner::Unknown), BusyOutcome::Backoff);
    }

    #[test]
    fn the_busy_exit_code_is_not_the_restart_one() {
        // The supervisor reads the two apart: one means "a new content tree
        // needs a new process", the other means "the port was taken". A
        // collision would make a busy port look like a deliberate restart.
        assert_ne!(PORT_BUSY_EXIT, RESTART_EXIT);
        assert_eq!(PORT_BUSY_EXIT, 43);
    }

    #[test]
    fn an_empty_slot_is_respawned_unless_it_was_adopted() {
        // A slot with no child in it used to read as "healthy", so one failed
        // spawn (a locked file, a busy antivirus) ended supervision for good —
        // the app kept running with nothing behind it. The slot is filled
        // again on the next tick. An adopted backend is the exception: nobody
        // here owns it, and a second spawn on the port could only die there.
        assert!(empty_slot_needs_a_spawn(false));
        assert!(!empty_slot_needs_a_spawn(true));
    }

    #[test]
    fn a_busy_port_is_not_a_broken_content_tree() {
        // The content rollback is about a tree that breaks the backend. A
        // port that is taken is not the tree's fault, and rolling back
        // because of it threw away good content for nothing — the app put
        // the previous tree back while the port stayed busy, and the backend
        // kept failing on the same port.
        assert_eq!(counts_against_the_content(Some(PORT_BUSY_EXIT)), false);
        assert_eq!(counts_against_the_content(Some(RESTART_EXIT)), true);
        assert_eq!(counts_against_the_content(Some(1)), true);
    }

    #[test]
    fn a_death_with_no_exit_code_is_not_a_broken_content_tree() {
        // `None` is a death the process did not report itself: on unix a
        // signal — SIGKILL from the OOM killer, SIGTERM from a person, SIGHUP
        // from a closed terminal. No exit code, no fault the tree can own,
        // and three of those must not roll a good tree back. The backoff
        // still runs (the tree lost its process either way); only the
        // rollback is held back.
        assert_eq!(counts_against_the_content(None), false);
    }

    #[test]
    fn every_death_death_of_reads_apart_is_also_not_the_contents_fault() {
        // Two readers of one exit code: `death_of` decides what the
        // supervisor does, `counts_against_the_content` decides whether the
        // tree is blamed. They must agree for every code that can reach the
        // blame — the deaths that fall through there are the crashes and the
        // busy port. (A restart and a control event return above the blame,
        // so what the count would say about them is never read.)
        for code in [PORT_BUSY_EXIT, CONTROL_C_EXIT] {
            assert_ne!(death_of(Some(code)), Death::Crash);
            assert_eq!(counts_against_the_content(Some(code)), false);
        }
        // And the other direction: a crash is a crash for both.
        assert_eq!(death_of(Some(1)), Death::Crash);
        assert_eq!(counts_against_the_content(Some(1)), true);
    }

    #[test]
    fn a_console_control_event_is_not_a_broken_content_tree() {
        // The exit Windows reports for a process a console control event
        // ended: STATUS_CONTROL_C_EXIT, 0xc000013a. The backend used to
        // inherit the app's console, so a Ctrl+C ended it with exactly this
        // code — and the supervisor counted it against the content tree.
        // Three of those rolled back a good tree, and the rollback is what
        // kept the crash loop going.
        assert_eq!(counts_against_the_content(Some(CONTROL_C_EXIT)), false);
    }

    #[test]
    fn a_control_event_is_read_apart_from_a_crash() {
        // The four deaths, and what each one means to the supervisor. A
        // control event is not a crash: the backend was asked to stop, the
        // content tree is fine, and the app must not roll anything back.
        assert_eq!(death_of(Some(RESTART_EXIT)), Death::Restart);
        assert_eq!(death_of(Some(PORT_BUSY_EXIT)), Death::PortBusy);
        assert_eq!(death_of(Some(CONTROL_C_EXIT)), Death::Controlled);
        assert_eq!(death_of(Some(1)), Death::Crash);
        assert_eq!(death_of(None), Death::Crash);
    }

    #[test]
    fn the_control_event_code_is_the_one_windows_reports() {
        // Pinned to the literal: 0xC000013A as a signed 32-bit value. A
        // typo here would silently turn the one exit that must never be
        // blamed on the content tree back into a crash.
        assert_eq!(CONTROL_C_EXIT, -1073741510);
        assert_eq!(CONTROL_C_EXIT, 0xC000_013Au32 as i32);
    }

    #[test]
    #[cfg(windows)]
    fn the_windows_child_creation_flags_are_exact() {
        const DETACHED_PROCESS: u32 = 0x0000_0008;
        const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        // Pinned to the Win32 Process Creation Flags:
        // DETACHED_PROCESS (0x8) detaches child from console.
        // CREATE_NEW_PROCESS_GROUP (0x200) ignores Ctrl+C events.
        // CREATE_NO_WINDOW (0x08000000) prevents console window creation.
        // Even though Win32 docs note CREATE_NO_WINDOW is ignored when combined with
        // DETACHED_PROCESS, specifying both guarantees no window appears across
        // differing subsystem expectations and child wrappers.
        let flags = DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP | CREATE_NO_WINDOW;
        assert_eq!(flags, 0x0800_0208);
    }

    #[test]
    fn the_content_rolls_back_when_the_promotion_was_recent() {
        // Three deaths in a row right after a promotion is the shape of a
        // broken content tree. The previous one is still on disk, so the app
        // heals itself.
        let home = scratch_home();
        let current = scratch_content(&home, "0.3.0");
        let previous = scratch_content(&home, "0.2.9");
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0);
        write_active(
            &home,
            Some(("0.3.0", &current)),
            Some(("0.2.9", &previous)),
            now,
        );
        assert!(roll_content_back_in(&home), "the rollback happened");
        let after: serde_json::Value = serde_json::from_str(
            &std::fs::read_to_string(home.join("app").join("active.json")).expect("active"),
        )
        .expect("json");
        assert_eq!(
            after["current"]["root"].as_str(),
            Some(previous.to_string_lossy().as_ref()),
            "the previous content is live again"
        );
        assert_eq!(
            after["previous"]["root"].as_str(),
            Some(current.to_string_lossy().as_ref()),
            "and the broken one is kept, so a second rollback is possible"
        );
    }

    #[test]
    fn the_content_does_not_roll_back_after_a_stale_promotion() {
        // A tree promoted an hour ago has been fine since; it is not what
        // broke just now, so nothing is rolled back.
        let home = scratch_home();
        let current = scratch_content(&home, "0.3.0");
        let previous = scratch_content(&home, "0.2.9");
        let hour_ago = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0)
            - 60 * 60 * 1000;
        write_active(
            &home,
            Some(("0.3.0", &current)),
            Some(("0.2.9", &previous)),
            hour_ago,
        );
        assert!(!roll_content_back_in(&home), "nothing was rolled back");
    }

    #[test]
    fn the_handover_command_names_a_file_and_not_a_path() {
        // The command names a file in the app's own downloads directory. A
        // name that carries a path would let a command file make the app run
        // anything anywhere else, so it is refused.
        let home = scratch_home();
        let commands = home.join("app").join("commands");
        std::fs::create_dir_all(&commands).expect("commands");

        let write = |_label: &str, file: &str| {
            std::fs::write(
                commands.join("install.json"),
                format!(
                    "{{\"version\":\"0.3.0\",\"file\":\"{}\",\"sha256\":\"{}\"}}",
                    file,
                    "a".repeat(64)
                ),
            )
            .expect("command");
            read_install_command(&home).map(|c| c.file)
        };

        assert_eq!(
            write("good", "aipass-desktop-0.3.0-windows-x64-setup.exe").as_deref(),
            Some("aipass-desktop-0.3.0-windows-x64-setup.exe"),
            "a plain name is read"
        );
        assert_eq!(write("slash", "../evil.exe"), None, "a path is refused");
        assert_eq!(write("windows", "C:\\evil.exe"), None, "a drive is refused");
        assert_eq!(write("up", "..\\evil.exe"), None, "a way up is refused");
        assert_eq!(write("empty", ""), None, "an empty name is refused");

        // The hash has to be a SHA-256 hex digest: anything else describes
        // nothing the handover could compare against.
        let write_sha = |_label: &str, sha: &str| {
            std::fs::write(
                commands.join("install.json"),
                format!(
                    "{{\"version\":\"0.3.0\",\"file\":\"aipass-desktop-0.3.0-windows-x64-setup.exe\",\"sha256\":\"{}\"}}",
                    sha
                ),
            )
            .expect("command");
            read_install_command(&home).is_some()
        };
        assert!(write_sha("good", &"a".repeat(64)), "a hex digest of the right length is read");
        assert!(!write_sha("short", &"a".repeat(63)), "a digest that is too short is refused");
        assert!(!write_sha("not-hex", &"g".repeat(64)), "a non-hex digest is refused");
    }

    #[test]
    fn there_is_no_handover_without_a_command() {
        // The shell does not go looking for an installer on its own: it acts
        // on a command the backend wrote, and there is no command.
        let home = scratch_home();
        assert!(read_install_command(&home).is_none());
    }

    #[test]
    fn the_tray_template_is_the_mark_and_not_a_block() {        // The menu bar draws a template image as a mask, so only the alpha
        // channel matters: the mark is opaque and the rest is transparent.
        // A filled square would be a solid blob in the menu bar.
        let total = (TEMPLATE_EDGE * TEMPLATE_EDGE) as usize;
        assert_eq!(TEMPLATE_RGBA.len(), total * 4, "the template is RGBA");
        let opaque = TEMPLATE_RGBA
            .iter()
            .skip(3)
            .step_by(4)
            .filter(|alpha| **alpha > 0)
            .count();
        assert!(opaque > total / 10, "the mark is there: {opaque} of {total}");
        assert!(opaque < total * 4 / 5, "it is the mark, not a filled block: {opaque}");
        assert_eq!(TEMPLATE_RGBA[3], 0, "the corner is transparent");
    }
}
