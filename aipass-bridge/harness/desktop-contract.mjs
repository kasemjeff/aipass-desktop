// @ts-check
// The facts the shell and the Node side must agree on, read from one file.
//
// The Rust shell cannot import JavaScript, and both halves need the same
// facts: the port the window asks for, the two exit codes the supervisor
// reads, the name of the app's state directory and the marker that says
// "this directory is an app root". Written down twice, they drift -- and a
// drift here is not cosmetic: the window polls 8790 while the backend binds
// another port, or the supervisor reads a deliberate restart as a crash and
// rolls back good content.
//
// So the facts live in `desktop-contract.json`: this module reads them for
// the Node side, and `desktop/src-tauri/build.rs` turns them into Rust
// constants at build time. A literal in either source tree is the drift this
// exists to prevent, and `test/desktop-contract.test.mjs` fails on one.
import fs from 'node:fs';

/**
 * @typedef {object} DesktopContract
 * @property {number} desktopPort
 * @property {number} restartExit
 * @property {number} portBusyExit
 * @property {string} appHomeDir
 * @property {string} appMarker
 */

const file = new URL('./desktop-contract.json', import.meta.url);
/** @type {DesktopContract} */
const contract = JSON.parse(fs.readFileSync(file, 'utf8'));

/** The port the desktop backend binds when `AIPASS_DESKTOP_PORT` says nothing. */
export const DEFAULT_DESKTOP_PORT = contract.desktopPort;

/** The exit code that means "restart me on purpose" (a promoted content tree). */
export const RESTART_EXIT = contract.restartExit;

/** The exit code that means "the port was taken". */
export const PORT_BUSY_EXIT = contract.portBusyExit;

/** The state directory's name under the person's home. */
export const APP_HOME_DIR = contract.appHomeDir;

/** The file that says "this directory is an app root". */
export const APP_MARKER = contract.appMarker;
