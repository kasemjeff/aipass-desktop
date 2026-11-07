//! The supervisor decisions, apart from the talking.
//!
//! What a busy port means, whether an empty slot needs a spawn, which
//! deaths count against the content tree, and what kind of death an exit
//! code was. Pure functions over the exit codes the backend reports, so
//! the rules are tested without a window, a backend, or a machine.

/// The exit code that means "restart me on purpose".
///
/// The backend promotes a new content tree and exits with this, because the
/// new tree needs a new process to run it. The supervisor reads it as a
/// deliberate restart and not as a crash to answer with backoff.
pub(crate) const RESTART_EXIT: i32 = 42;

/// The exit code that means "the port was taken".
///
/// A busy port is not a crash: it is a fact about the machine. The two facts
/// that can cause it need opposite answers — one of OUR backends answering
/// there means adopt it, something else holding it means restarting cannot
/// help — and the supervisor can only tell them apart if the backend says
/// which one it was.
pub(crate) const PORT_BUSY_EXIT: i32 = 43;

/// The exit code Windows reports for a process that a console control event
/// ended — STATUS_CONTROL_C_EXIT, which is what a Ctrl+C leaves behind.
///
/// It is not a crash, and it is not the content tree's fault. The backend used
/// to inherit the app's console, so a console-wide Ctrl+C reached it and
/// Windows ended it with this code. The supervisor read that as the content
/// tree breaking the backend, rolled back good content for it, and the
/// rollback is what turned one Ctrl+C into a crash loop: the log showed the
/// same `0xc000013a` again and again, each time followed by "the content tree
/// broke the backend three times in a row — the previous one is back".
///
/// So the code is named here, read apart from a genuine crash, and never
/// counted against the content tree.
pub(crate) const CONTROL_C_EXIT: i32 = 0xC000_013Au32 as i32;

/// Who is answering on the backend's port.
#[derive(PartialEq, Eq, Debug)]
pub(crate) enum PortOwner {
    /// One of our backends, from this app or another one.
    Ours,
    /// Something that is not our backend holds the port.
    Stranger,
    /// Nothing is listening.
    Empty,
    /// The probe could not say — the content tree it needs is missing, say.
    Unknown,
}

/// What the supervisor does with a backend that could not bind its port.
#[derive(PartialEq, Eq, Debug)]
pub(crate) enum BusyOutcome {
    /// One of our backends is answering there: adopt it, and stop restarting.
    Adopt,
    /// Something else holds the port: name it once, and keep the backoff.
    Name,
    /// Nothing to say — the ordinary backoff is the answer.
    Backoff,
}

/// The decision, apart from the talking: what a busy port means.
///
/// Split out from the supervisor so the rule can be tested without a window,
/// a backend and a machine. The two answers are opposites: one of our
/// backends is already there (adopt it — the window is pointed at that port
/// and is already talking to the right one), or something else is holding it
/// (restarting cannot help, so say so and back off).
pub(crate) fn busy_outcome(owner: PortOwner) -> BusyOutcome {
    match owner {
        PortOwner::Ours => BusyOutcome::Adopt,
        PortOwner::Stranger => BusyOutcome::Name,
        PortOwner::Empty | PortOwner::Unknown => BusyOutcome::Backoff,
    }
}

/// The decision, apart from the talking: does an empty child slot need a
/// spawn?
///
/// A `None` slot is two different situations with opposite answers, and
/// reading both as "healthy" is what ended supervision on the first failed
/// spawn — the app kept running with nothing behind it. An adopted backend
/// is left alone (the window already talks to it; a second spawn on the
/// port could only die there). An empty slot nobody adopted is filled on
/// the next tick, under the ordinary backoff.
pub(crate) fn empty_slot_needs_a_spawn(adopted: bool) -> bool {
    !adopted
}

/// Does this exit count towards "the content tree is broken"?
///
/// A busy port is not the tree's fault. The rollback exists for a promoted
/// tree that breaks the backend, and rolling back because the port was taken
/// threw away good content for nothing — the app put the previous tree back
/// while the port stayed busy, and the backend kept failing.
///
/// A console control event is not the tree's fault either, and it is the one
/// that mattered most: the backend used to inherit the app's console, so a
/// Ctrl+C ended it with STATUS_CONTROL_C_EXIT, and three of those in a row
/// rolled back a content tree that was perfectly fine. The Ctrl+C is gone now
/// (the backend is spawned detached), but the code is still read apart: an
/// exit that a person asked for is never the tree's fault, and a build that
/// predates the fix still needs to survive one.
///
/// A death with NO exit code is not the tree's fault either: on unix that is
/// a signal — the OOM killer, a closed terminal, a person's kill — and the
/// process named no fault of its own. The tree still loses its process (the
/// backoff below runs), but the rollback only ever fires for a crash the
/// process reported with a code.
pub(crate) fn counts_against_the_content(code: Option<i32>) -> bool {
    match code {
        Some(code) => code != PORT_BUSY_EXIT && code != CONTROL_C_EXIT,
        None => false,
    }
}

/// What kind of death this was, as the supervisor reads it.
///
/// The three answers need three different treatments, and mixing them up is
/// what turned one Ctrl+C into a crash loop: the old code read every death
/// that was not "the port was taken" as "the content tree broke the backend",
/// so a control event rolled back good content and the rollback is what
/// kept the loop going.
#[derive(PartialEq, Eq, Debug)]
pub(crate) enum Death {
    /// A deliberate restart: a new content tree needs a new process.
    Restart,
    /// The port was taken. Who took it is a separate question.
    PortBusy,
    /// Somebody asked the backend to stop (a console control event).
    Controlled,
    /// A genuine crash: the tree may be at fault.
    Crash,
}

/// Read an exit code as the kind of death it is.
pub(crate) fn death_of(code: Option<i32>) -> Death {
    match code {
        Some(RESTART_EXIT) => Death::Restart,
        Some(PORT_BUSY_EXIT) => Death::PortBusy,
        Some(CONTROL_C_EXIT) => Death::Controlled,
        _ => Death::Crash,
    }
}
