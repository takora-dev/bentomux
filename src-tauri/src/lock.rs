/* ---------------- poison-tolerant locking ----------------
A panic anywhere under a lock poisons the mutex, and every later
`lock().unwrap()` panics too — one bad frame walks through the app a thread
at a time until the window is dead. None of the state guarded here is
half-written in a way that is worse than the freeze, so the right answer is
to take the guard back and let the next event correct it.

`recover` is the same helper the pty host grew for exactly this reason; it
lives here so the rest of the crate does not have to rediscover it, and
`LockExt` puts it behind the same `.lock()` call so a call site only has to
swap `.unwrap()` for `.recover()`. */

use std::sync::{Mutex, MutexGuard, PoisonError};

pub fn recover<T>(result: Result<T, PoisonError<T>>) -> T {
    result.unwrap_or_else(|poisoned| poisoned.into_inner())
}

pub trait LockExt<T> {
    /// Take the guard even if a previous holder panicked while holding it.
    fn lock_recover(&self) -> MutexGuard<'_, T>;
}

impl<T> LockExt<T> for Mutex<T> {
    fn lock_recover(&self) -> MutexGuard<'_, T> {
        recover(self.lock())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;

    #[test]
    fn a_poisoned_mutex_still_hands_back_its_guard() {
        let m = Arc::new(Mutex::new(7));
        let poisoner = Arc::clone(&m);
        let _ = std::thread::spawn(move || {
            let _guard = poisoner.lock().unwrap();
            panic!("poison it");
        })
        .join();

        assert!(m.is_poisoned(), "the panic should have poisoned the mutex");
        assert_eq!(*m.lock_recover(), 7, "recover must not panic");
    }

    #[test]
    fn a_healthy_mutex_locks_normally() {
        let m = Mutex::new(String::from("ok"));
        assert_eq!(*m.lock_recover(), "ok");
    }
}
