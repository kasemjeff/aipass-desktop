//! The backend child, kept restartable.
//!
//! Spawn recipe, readiness probe, backoff, port-busy handling, the
//! content-tree rollback trigger, and the --install-and-relaunch
//! handover helper. The window outlives a backend crash (the page
//! EventSource redials), so this shell outlives it too.

use std::path::PathBuf;
use std::process::Command;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use crate::paths::*;
use crate::processes::*;
use crate::supervisor::*;

/// The backend child, kept restartable.
///
/// The window outlives a backend crash — the page's EventSource redials and
/// restores from the session snapshot — so the shell that spawned the backend
/// should outlive it too. This holds the spawn recipe, watches the child, and
/// replaces it with backoff. `quitting` flips on Destroyed, so a deliberate
/// exit is not "a crash" the supervisor answers with a fresh child.
pub(crate) struct Backend {
    pub(crate) child: Mutex<Option<std::process::Child>>,
    pub(crate) quitting: AtomicBool,
    pub(crate) fails: Mutex<u32>,
    /// The failures the content tree can own — what
    /// `counts_against_the_content` blames. The content rollback is about a
    /// broken tree, and a busy port is not a broken tree: rolling back
    /// because the port was taken threw away good content for nothing. Nor is
    /// a death that carries no code: the tree did not report that one.
    pub(crate) content_fails: Mutex<u32>,
    pub(crate) next_try: Mutex<Instant>,
    /// Set once the port has been found to be held by something that is not
    /// our backend, so the situation is named once instead of on every retry.
    pub(crate) port_busy: AtomicBool,
    /// Set when the child slot is empty because the shell ADOPTED a backend
    /// that was already answering on the port: nobody here owns that process,
    /// so nobody here may respawn it. The other way the slot comes to hold
    /// no child — a spawn that failed — must keep trying, which is why the
    /// two need a word each: a `None` child used to read as "healthy", and
    /// one failed spawn ended supervision for good.
    pub(crate) adopted: AtomicBool,
    node: String,
    /// Where the app's files may be, in the order they are tried. The root
    /// is picked on every spawn, so a promoted content tree is picked up
    /// without reinstalling anything.
    candidates: Vec<(PathBuf, &'static str)>,
    port: u16,
    cwd: PathBuf,
    /// The app itself, for the handover: the shell is what has to close for
    /// the installer to do its work.
    handle: tauri::AppHandle,
    /// A weak look back at the Arc this backend lives in, filled right after
    /// construction. `port_owner_with_deadline` needs a `'static` handle to
    /// ask the probe on its own thread — a `&self` cannot cross a thread.
    pub(crate) self_handle: Mutex<Option<std::sync::Weak<Backend>>>,
}

impl Backend {
    /// One backend, counted from nothing: no child, no failures, no
    /// adopted stranger on the port. The caller fills the weak
    /// self-handle right after wrapping this in an Arc.
    pub(crate) fn new(
        node: String,
        candidates: Vec<(PathBuf, &'static str)>,
        port: u16,
        cwd: PathBuf,
        handle: tauri::AppHandle,
    ) -> Self {
        Self {
            child: Mutex::new(None),
            quitting: AtomicBool::new(false),
            fails: Mutex::new(0),
            content_fails: Mutex::new(0),
            next_try: Mutex::new(Instant::now()),
            port_busy: AtomicBool::new(false),
            adopted: AtomicBool::new(false),
            node,
            candidates,
            port,
            cwd,
            handle,
            self_handle: Mutex::new(None),
        }
    }

    pub(crate) fn spawn(&self) -> std::io::Result<std::process::Child> {
        // The root is resolved HERE, not once at startup: a content update
        // promotes a new tree, and the backend that runs it has to be
        // started from there.
        let (root, source) = pick_root(&self.candidates);
        let entry = root.join("aipass-bridge").join("harness").join("rpc.mjs");
        let mut command = Command::new(&self.node);
        command
            .arg(&entry)
            .args(["--port", &self.port.to_string()])
            .args(["--root", self.cwd.to_str().unwrap_or(".")])
            .current_dir(&self.cwd)
            // The two halves of a build, named for the backend so the window
            // can answer "which build is this?" without asking the machine.
            .env("AIPASS_SHELL_VERSION", env!("CARGO_PKG_VERSION"))
            .env("AIPASS_CONTENT_SOURCE", source)
            .env("AIPASS_NODE_PATH", &self.node);
        if let Some(log) = backend_log_file() {
            if let Ok(dup) = log.try_clone() {
                command.stdout(log).stderr(dup);
            }
        }
        // The backend must NOT share this process's console.
        //
        // A child inherits the console of the process that started it, and
        // Windows delivers a console control event — a Ctrl+C in the terminal
        // that launched the app — to EVERY process attached to that console.
        // The backend used to be spawned with no flags at all, so it shared
        // the console, and a Ctrl+C ended it with STATUS_CONTROL_C_EXIT
        // (0xc000013a). The supervisor read that as the content tree breaking
        // the backend, rolled back a perfectly good tree after three such
        // deaths, and the rollback is what kept the loop going.
        //
        // DETACHED_PROCESS gives the child its own console, so it is not
        // attached to ours and a control event cannot reach it.
        // CREATE_NEW_PROCESS_GROUP stops the child from receiving Ctrl+C, and
        // CREATE_NO_WINDOW keeps a console from flashing on screen.
        //
        // This is proven, not assumed: a child spawned with these flags
        // survives a console-wide GenerateConsoleCtrlEvent, while a child
        // spawned without them exits with 0xC000013A.
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            const DETACHED_PROCESS: u32 = 0x0000_0008;
            const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;
            const CREATE_NO_WINDOW: u32 = 0x0800_0000;
            command.creation_flags(
                DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP | CREATE_NO_WINDOW,
            );
        }
        #[cfg(unix)]
        {
            use std::os::unix::process::CommandExt;
            // Its own process group, so one signal on quit reaches the
            // backend *and* the bridge it started — no orphans.
            command.process_group(0);
        }
        command.spawn()
    }

    /// Who is answering on our port.
    ///
    /// A bare TCP connect is not the question: something that is NOT our
    /// backend can hold the port, and adopting it would point the window at a
    /// stranger's server. The launcher asks the real question — is this our
    /// backend? — through `harness/backend-probe.mjs`, and the shell asks the
    /// SAME module, through the app's own Node: one implementation of the
    /// question, so the window and the launcher cannot drift apart.
    ///
    /// The probe is asked, not guessed. A content tree that is broken enough
    /// to take the probe with it answers `Unknown`, and the caller decides
    /// what to do about not knowing — it does not decide it means "not ours".
    pub(crate) fn port_owner(&self) -> PortOwner {
        let (root, _) = pick_root(&self.candidates);
        let probe = root
            .join("aipass-bridge")
            .join("harness")
            .join("backend-probe.mjs");
        // The probe is the only implementation of this question — it has an
        // HTTP client, the shell does not. The fallback below exists for the
        // one case the probe cannot run in: the probe file itself is gone
        // (node missing too). See `http_probe_owner`.
        if !probe.exists() {
            return http_probe_owner(self.port).unwrap_or(PortOwner::Empty);
        }
        match Command::new(&self.node)
            .arg(&probe)
            .arg(self.port.to_string())
            .output()
        {
            Ok(out) if out.status.success() => {
                let text = String::from_utf8_lossy(&out.stdout);
                if text.trim() == "ours" {
                    return PortOwner::Ours;
                }
            }
            Ok(_) => {
                // The probe ran and could not answer — a non-zero exit is "I
                // could not say", not "nothing is there". The probe's own
                // contract says so, and the enum has a word for it: the
                // content tree it needs is missing, so the caller is told it
                // does not know rather than handed a guess.
                return PortOwner::Unknown;
            }
            Err(_) => return http_probe_owner(self.port).unwrap_or(PortOwner::Empty),
        }
        // It answered "other": something is there, and it is not ours.
        if std::net::TcpStream::connect(("127.0.0.1", self.port)).is_ok() {
            PortOwner::Stranger
        } else {
            PortOwner::Empty
        }
    }

    /// The probe, with a deadline. A wedged node would hold whoever waits
    /// forever — a probe with no deadline once held the supervisor's child
    /// mutex with it. The ask runs on its own thread and eight seconds is all
    /// it gets: the caller takes "unknown" and moves on. A losing thread is
    /// at most one per wedged probe, and it owns one wedged child already; it
    /// finishes into the void without holding anything the supervisor needs.
    pub(crate) fn port_owner_with_deadline(&self) -> PortOwner {
        let backend = self
            .self_handle
            .lock()
            .unwrap()
            .as_ref()
            .and_then(std::sync::Weak::upgrade);
        let Some(backend) = backend else {
            return PortOwner::Unknown;
        };
        let (sender, receiver) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            let _ = sender.send(backend.port_owner());
        });
        receiver
            .recv_timeout(Duration::from_secs(8))
            .unwrap_or(PortOwner::Unknown)
    }

    /// One watch tick: a dead child is replaced, a live one resets the backoff.
    pub(crate) fn tick(&self) {
        if self.quitting.load(Ordering::SeqCst) {
            return;
        }
        // A command from the backend: the shell is the one that has to close
        // for the installer to do its work, so the handover starts here.
        if let Some(command) = read_install_command(&aipass_home()) {
            self.handover(command);
            return;
        }
        let mut guard = self.child.lock().unwrap();
        // try_wait consumes the exit status, so read it here: the note names
        // the code (or the signal) instead of just "exited", which is what
        // turns "restart attempt 1 × 40" from a mystery into a diagnosis.
        let mut status: Option<std::process::ExitStatus> = None;
        let exited = match guard.as_mut() {
            Some(kid) => match kid.try_wait() {
                Ok(s) => {
                    status = s;
                    s.is_some()
                }
                _ => false,
            },
            None => false,
        };
        if !exited {
            // A live child clears the episode: the next crash starts from the
            // first backoff step, not from wherever the last one left off. An
            // adopted backend does too — and more: nobody here owns it, so
            // nobody here may respawn it (the window is pointed at that port
            // already). An empty slot that is NEITHER of those is a spawn that
            // failed, and it falls through to the same backoff a crash gets:
            // one transient spawn error (a locked file, a busy antivirus) used
            // to end supervision for good, leaving the app running with
            // nothing behind it and the page redialling into the void.
            if guard.is_some() || !empty_slot_needs_a_spawn(self.adopted.load(Ordering::SeqCst)) {
                *self.fails.lock().unwrap() = 0;
                *self.content_fails.lock().unwrap() = 0;
                *self.next_try.lock().unwrap() = Instant::now();
                self.port_busy.store(false, Ordering::SeqCst);
                return;
            }
        }
        // A backend that asked to be restarted is not a crash: it promoted a
        // new content tree and needs a new process to run it. The backoff
        // does not apply, and the note says why — a log line that reads
        // "restart attempt 1 of a crash" is a lie about what happened.
        match death_of(status.and_then(|s| s.code())) {
            Death::Restart => {
                *self.fails.lock().unwrap() = 0;
                *self.next_try.lock().unwrap() = Instant::now();
                note("backend asked for a restart (a new content version) — starting it again");
                match self.spawn() {
                    Ok(kid) => { *guard = Some(kid); self.adopted.store(false, Ordering::SeqCst); }
                    Err(err) => note(&format!("backend restart failed: {err}")),
                }
                return;
            }
            Death::Controlled => {
                // Somebody asked the backend to stop. It is not a crash, it is
                // not the content tree's fault, and — the part that matters —
                // it must not roll the content back: three control events in a
                // row used to throw away a good tree and leave the app unable
                // to start, all because a Ctrl+C had reached the backend.
                //
                // The backend is spawned detached now, so this should not
                // happen any more; it is still handled, because a build that
                // predates the fix has to survive one, and because the
                // supervisor's job is to tell the truth about what happened.
                *self.fails.lock().unwrap() = 0;
                *self.content_fails.lock().unwrap() = 0;
                *self.next_try.lock().unwrap() = Instant::now();
                note("backend was stopped by a console control event — starting it again, the content tree is fine");
                match self.spawn() {
                    Ok(kid) => { *guard = Some(kid); self.adopted.store(false, Ordering::SeqCst); }
                    Err(err) => note(&format!("backend restart failed: {err}")),
                }
                return;
            }
            Death::PortBusy => {
                // The probe can take seconds, and the mutex guards the child
                // slot — not the port. Every other path that wants the slot
                // (the boot gate, a spawn, shutdown) must not queue behind a
                // subprocess nobody can hurry, and the child in the slot is
                // dead anyway: put the slot down, ask the port, pick it up.
                drop(guard);
                let outcome = busy_outcome(self.port_owner_with_deadline());
                let mut guard = self.child.lock().unwrap();
                match outcome {
                    BusyOutcome::Adopt => {
                        // One of our backends is already answering there — a second
                        // window, a browser `aipass desktop`, an instance this app
                        // started and lost track of. The window is pointed at that
                        // port, so it is already talking to the right backend:
                        // adopt it, and stop starting another one that could only
                        // die on the same port.
                        *self.fails.lock().unwrap() = 0;
                        *self.content_fails.lock().unwrap() = 0;
                        *self.next_try.lock().unwrap() = Instant::now();
                        *guard = None;
                        self.adopted.store(true, Ordering::SeqCst);
                        self.port_busy.store(false, Ordering::SeqCst);
                        note("another aipass backend is answering on the port — it is adopted, and no second one is started");
                        return;
                    }
                    BusyOutcome::Name => {
                        // Something that is not ours holds the port. Restarting
                        // cannot fix that, and a loop that cannot win is what made
                        // the app look broken: name it once, with the fix, and
                        // keep the polite backoff so the port is picked up again
                        // if it is freed.
                        if !self.port_busy.swap(true, Ordering::SeqCst) {
                            note(&format!(
                                "port {} is held by something that is not an aipass backend — close it, or start the app with AIPASS_DESKTOP_PORT=<other>",
                                self.port
                            ));
                        }
                    }
                    BusyOutcome::Backoff => {
                        // Nothing is there, or the probe could not say. Either
                        // way the ordinary backoff below is the right answer.
                        self.port_busy.store(false, Ordering::SeqCst);
                    }
                }
                self.backoff_and_restart(status, &mut guard);
                return;
            }
            Death::Crash => {
                // A genuine crash — the only death that reaches the blame
                // below. Whether the tree is actually blamed is
                // counts_against_the_content's answer: a crash with no code
                // (a signal on unix) names no fault, and rolls nothing back.
            }
        }
        self.backoff_and_restart(status, &mut guard);
    }

    /// The backoff bookkeeping and the restart, shared by the deaths that
    /// reach them: the counter moves, the note is said, and a new child takes
    /// the slot. Split out of `tick` so the port probe can put the child
    /// mutex down and pick it back up without the two tripping over each
    /// other.
    pub(crate) fn backoff_and_restart(&self, status: Option<std::process::ExitStatus>, guard: &mut Option<std::process::Child>) {
        let mut fails = self.fails.lock().unwrap();
        let mut next = self.next_try.lock().unwrap();
        if Instant::now() < *next {
            return;
        }
        *fails += 1;
        // A busy port is not the content's fault, so it does not count towards
        // the rollback below: a tree that is fine was thrown away once because
        // the port was taken.
        if counts_against_the_content(status.and_then(|s| s.code())) {
            *self.content_fails.lock().unwrap() += 1;
        }
        // Three deaths in a row, right after a content promotion, is the
        // shape of a broken content tree. The previous one is still on disk,
        // so the app puts it back instead of sitting there unable to start.
        if *self.content_fails.lock().unwrap() == 3 && roll_content_back() {
            *fails = 0;
            *self.content_fails.lock().unwrap() = 0;
            *next = Instant::now();
            return;
        }
        // 2s, doubling to half a minute: a backend that dies on start — a port
        // grabbed by hand, a broken config — retries politely, and a crash
        // loop cannot spin the CPU or flood the log.
        let delay = Duration::from_secs((2u64 << (*fails - 1).min(4)).min(30));
        *next = Instant::now() + delay;
        // A crash loop that always lands on the same code is one bug, not N:
        // after five straight failures the note says so instead of adding
        // another identical line. And nothing exited when the START failed —
        // the note says that, rather than a false "exited".
        let what = status
            .map(|s| format!("backend exited ({s})"))
            .unwrap_or_else(|| "backend could not be started".into());
        if *fails >= 5 {
            note(&format!(
                "{what} — {} straight failures, same note suppressed until it recovers or the code changes",
                *fails,
            ));
        } else {
            note(&format!("{what} — restart attempt {fails}"));
        }
        match self.spawn() {
            Ok(kid) => { *guard = Some(kid); self.adopted.store(false, Ordering::SeqCst); }
            Err(err) => note(&format!("backend restart failed: {err}")),
        }
    }

    /// Hand the app over to the installer.
    ///
    /// The installer replaces the binary, and a running binary is locked on
    /// Windows — so the app closes, the installer runs, and the app comes
    /// back. The helper is this same executable with an argument, so
    /// nothing has to be quoted into a shell and nothing depends on a shell
    /// being there at all.
    ///
    /// The backend verified the artifact against the signed feed before it
    /// wrote the command. The shell checks it AGAIN, with the app's own Node:
    /// the file on disk is the thing that runs, and the hash is the only
    /// thing that says it is the file the release key signed.
    pub(crate) fn handover(&self, command: InstallCommand) {
        let home = aipass_home();
        let (command_file, downloads) = command_paths(&home);
        let artifact = downloads.join(&command.file);
        if !artifact.is_file() {
            note(&format!(
                "the installer for {} is not where it should be — nothing was started",
                command.version
            ));
            let _ = std::fs::remove_file(&command_file);
            return;
        }
        match hash_with_node(&self.node, &artifact, &home) {
            Some(digest) if digest.eq_ignore_ascii_case(&command.sha256) => {}
            Some(digest) => {
                note(&format!(
                    "the installer for {} does not match the hash it was handed ({} != {}) — nothing was started",
                    command.version, digest, command.sha256
                ));
                let _ = std::fs::remove_file(&command_file);
                return;
            }
            None => {
                note(&format!(
                    "the installer for {} could not be hashed — nothing was started",
                    command.version
                ));
                let _ = std::fs::remove_file(&command_file);
                return;
            }
        }
        let Ok(exe) = std::env::current_exe() else {
            note("the app does not know where its own executable is — nothing was started");
            return;
        };
        let mut helper = Command::new(&exe);
        helper
            .arg("--install-and-relaunch")
            .arg(&artifact)
            .arg(&exe)
            // The digest rides along: the helper re-checks the file at the
            // moment it runs it, closing the gap between this check and the
            // helper's start.
            .arg(&command.sha256);
        // Detached: the helper has to outlive this process, which is about to
        // exit.
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            // DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP
            helper.creation_flags(0x0000_0008 | 0x0000_0200);
        }
        #[cfg(unix)]
        {
            use std::os::unix::process::CommandExt;
            helper.process_group(0);
        }
        match helper.spawn() {
            Ok(_) => {
                note(&format!(
                    "handing over to the installer for {} — the app will come back",
                    command.version
                ));
                let _ = std::fs::remove_file(&command_file);
                self.handle.exit(0);
            }
            Err(err) => note(&format!("the handover did not start: {err}")),
        }
    }

    /// The app is quitting: no more restarts, and the child goes down with us.
    /// No window reload on restart, deliberately: the page redials on its own
    /// and a forced reload would throw away whatever the composer holds.
    pub(crate) fn shutdown(&self) {
        self.quitting.store(true, Ordering::SeqCst);
        if let Some(kid) = self.child.lock().unwrap().take() {
            stop_backend(kid.id());
        }
    }
}

/// The backend port, shared with the JS side: `AIPASS_DESKTOP_PORT` wins, the
/// loopback default is 8790. A value that is not a port is refused rather than
/// guessed — the window must look at the same port the backend is on.
/// Does a token-less POST /rpc answer carry our backend's own words?
///
/// Pure twin of `backendIsUp()` in `harness/backend-probe.mjs`: a 200 is
/// not enough (a stranger can answer 200 to anything), so the answer must
/// carry our shape — the status the backend answers with — or the backend's
/// own refusal, which a token-less probe gets from OUR backend when the
/// token on disk differs from the one it minted.
pub(crate) fn http_probe_identifies_ours(body: &str) -> bool {
    body.contains("unauthorized: missing or wrong loopback bearer token")
        || (body.contains("\"ok\":true")
            && body.contains("\"root\"")
            && body.contains("\"extensions\""))
}

/// The degraded port ask: when the probe cannot run (the probe file is gone,
/// or node cannot be started), ask the port over raw HTTP ourselves instead
/// of answering Unknown forever and never noticing the port is really ours.
/// This is the fallback, not the probe — the probe still writes the answer
/// when it can. A port with nothing answering returns None and the caller
/// reads that as Empty; a port that answers but is not ours is Stranger.
fn http_probe_owner(port: u16) -> Option<PortOwner> {
    use std::io::{Read, Write};
    let mut stream = std::net::TcpStream::connect(("127.0.0.1", port)).ok()?;
    stream
        .set_read_timeout(Some(Duration::from_secs(2)))
        .ok()?;
    stream
        .set_write_timeout(Some(Duration::from_secs(2)))
        .ok()?;
    stream
        .write_all(b"POST /rpc HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Type: application/json\r\nContent-Length: 19\r\nConnection: close\r\n\r\n{\"method\":\"status\"}")
        .ok()?;
    let mut buf = vec![0u8; 65_536];
    let mut body = String::new();
    loop {
        let n = stream.read(&mut buf).ok()?;
        if n == 0 {
            break;
        }
        body.push_str(&String::from_utf8_lossy(&buf[..n]));
        if body.len() > 32_768 {
            break;
        }
    }
    if http_probe_identifies_ours(&body) {
        Some(PortOwner::Ours)
    } else {
        Some(PortOwner::Stranger)
    }
}

pub(crate) fn backend_port() -> Result<u16, Box<dyn std::error::Error>> {
    match std::env::var("AIPASS_DESKTOP_PORT") {
        Ok(raw) if !raw.trim().is_empty() => {
            let port: u16 = raw
                .trim()
                .parse()
                .map_err(|_| format!("AIPASS_DESKTOP_PORT is not a port: {raw}"))?;
            // Port 0 is a port NUMBER, not a port: the child reads it as "any
            // free port" and binds one the OS picked, while the window has to
            // open a URL for it and the readiness probe has to connect to it.
            // Neither can name a port nobody was told. Refuse it here, and the
            // Node side refuses it too (desktop/main.mjs) so the two agree.
            if port == 0 {
                return Err(format!("AIPASS_DESKTOP_PORT is not a port: {raw}").into());
            }
            Ok(port)
        }
        _ => Ok(crate::shared::DEFAULT_DESKTOP_PORT),
    }
}

/// The handover helper: install, then bring the app back.
///
/// It runs BEFORE the app is built: it is not an app, it is the app's own
/// executable with an argument, and it is what lets the installer run while
/// the app is closed. Nothing is quoted into a shell, so nothing depends on
/// a shell being there — the Windows-clean rule holds.
///
/// It answers with the exit code of the installer, and it always brings the
/// app back: a person who asked for an update and got a closed window and no
/// app is worse off than before.
pub(crate) fn handover_helper() -> Option<Result<(), Box<dyn std::error::Error>>> {
    let args: Vec<String> = std::env::args().collect();
    let at = args.iter().position(|a| a == "--install-and-relaunch")?;
    let installer = args.get(at + 1)?.clone();
    let app = args.get(at + 2)?.clone();
    let expected = args.get(at + 3).cloned().unwrap_or_default();
    note(&format!("the handover helper is running {installer}"));
    // The digest rides along so the file is verified again HERE, at the
    // moment it is about to run: the gap between the shell's check and this
    // process's start is exactly the window in which a swapped artifact
    // would take the installer's place. A hash that stopped matching says
    // the file on disk is not what the release key signed — the installer
    // slot below is emptied, so nothing runs, and the app still comes back.
    let node = std::env::current_exe()
        .ok()
        .and_then(|exe| exe.parent().map(|dir| dir.to_path_buf()))
        .and_then(|dir| find_node(&dir, None))
        .map(|path| path.to_string_lossy().to_string())
        .unwrap_or_else(|| "node".to_string());
    // The only thing a handover may name is the artifact the shell itself
    // placed in its own downloads directory — the same containment the
    // command file is held to — so a helper invocation that points anywhere
    // else is not a handover and runs nothing.
    let in_downloads = std::path::Path::new(&installer).starts_with(command_paths(&aipass_home()).1);
    let verified = in_downloads
        && hash_with_node(&node, std::path::Path::new(&installer), &aipass_home())
            .map(|digest| digest.eq_ignore_ascii_case(&expected))
            .unwrap_or(false);
    // An empty program name cannot start, which is the point: the spawn
    // below errors, the log already carries the real reason, and the only
    // thing that still happens is the relaunch at the bottom.
    let installer = if verified {
        installer
    } else {
        note("the installer's hash no longer matches what the handover checked — nothing was run");
        String::new()
    };
    // The installer is silent on Windows and does its work; the exit code
    // says whether it did. When the re-check above emptied the slot, this is
    // where the run dies — the error names the empty program, and the real
    // reason is already in the log above.
    let status = Command::new(&installer).arg("/S").status();
    match status {
        Ok(s) if s.success() => note("the installer finished"),
        Ok(s) => note(&format!("the installer exited {s}")),
        Err(err) => note(&format!("the installer could not be run: {err}")),
    }
    // And the app comes back either way: the build that is installed still
    // works, and a person who asked for an update must not be left with no
    // app at all because the artifact went bad in the gap.
    match Command::new(&app).spawn() {
        Ok(_) => note("the app is back"),
        Err(err) => note(&format!("the app could not be started again: {err}")),
    }
    Some(Ok(()))
}
