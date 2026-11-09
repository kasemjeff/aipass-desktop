//! The facts the shell shares with the Node side, generated at build time.
//!
//! The Rust shell cannot import JavaScript, so the values it must agree with
//! the backend on -- the desktop port, the two supervisor exit codes, the app
//! home's name and the root marker -- live in one file
//! (`aipass-bridge/harness/desktop-contract.json`). `build.rs` reads it and
//! writes the constants below; the Node side reads the same file at runtime
//! (`harness/desktop-contract.mjs`). A literal in either source tree is the
//! drift this arrangement exists to prevent.
include!(concat!(env!("OUT_DIR"), "/shared.rs"));

use std::sync::{Mutex, MutexGuard};

/// Lock a mutex, recovering from a poisoned one.
///
/// Every mutex in the shell guards an `Option` or a counter, and a panic
/// while holding one of those does not corrupt the value inside — the
/// payload is still a valid `Option`/`u32`/`Instant`. So a poisoned mutex
/// is not a reason to crash the shell: take the guard back and carry on.
/// That is what `unwrap_or_else(|e| e.into_inner())` does, and it replaces
/// every `.lock().unwrap()` in the shell (25 sites) with one helper, so the
/// next lock site cannot reintroduce the panic.
pub(crate) fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}
