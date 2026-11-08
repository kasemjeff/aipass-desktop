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
