/* ---------------- approval overlay window (floating "dynamic island") ----------------
Port of src/main/overlay.ts from the Electron build. When Bentomux is
not the frontmost window, a PermissionRequest pops a small always-on-top
pill at the top-center of the SCREEN so the decision can be made without
switching to Bentomux (e.g. while browsing).

The overlay is created on demand, NOT at startup: a startup load fails
silently (dev-server hiccup, HMR reload, crashed renderer) and would leave
an empty transparent shell that every later request re-shows. Recovery is
self-healing: the page signals readiness by setting its window title to
READY_TITLE, and a window that never became ready is destroyed and rebuilt
on the next request. The window never takes focus — the user's foreground
app keeps keyboard input. Resizing persists the size to prefs.approvalOverlay. */

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, OnceLock};

use tauri::{
    webview::PageLoadEvent, AppHandle, LogicalPosition, LogicalSize, Manager, WebviewUrl,
    WebviewWindow, WebviewWindowBuilder, WindowEvent,
};

const OVERLAY_MIN_W: f64 = 480.0;
const OVERLAY_MIN_H: f64 = 220.0;
const LABEL_PREFIX: &str = "approval-overlay";
/* the page sets its window title to this once its module is live; a window
still carrying the static title hosts no usable page */
const READY_TITLE: &str = "bentomux-approval-ready";

/* the Vite dev server / bundled assets live at the same origin as the main
window, so approval.html resolves naturally in both dev and prod. */
const OVERLAY_PAGE: &str = "approval.html";

static SEQ: AtomicU64 = AtomicU64::new(0);

/* label of the overlay window currently on record; unique per build so a
destroyed shell can never be confused with a live one */
fn active_label() -> &'static Mutex<Option<String>> {
    static ACTIVE: OnceLock<Mutex<Option<String>>> = OnceLock::new();
    ACTIVE.get_or_init(|| Mutex::new(None))
}

/* the overlay window on record, if it still exists */
pub fn active_overlay(app: &AppHandle) -> Option<WebviewWindow> {
    let label = active_label().lock().unwrap().clone()?;
    app.get_webview_window(&label)
}

/* hide whatever overlay currently exists (decisions resolved elsewhere) */
pub fn hide_active_overlay(app: &AppHandle) {
    match active_overlay(app) {
        Some(w) => {
            let _ = w.set_always_on_top(false);
            let _ = w.hide();
            eprintln!("[bentomux] overlay hidden label={}", w.label());
        }
        None => eprintln!("[bentomux] overlay hide: none active"),
    }
}

/* destroy whatever overlay currently exists — the page's dismiss path uses
this instead of window.close(), which WebView2 may refuse for windows not
opened by script */
pub fn dismiss_active_overlay(app: &AppHandle) {
    match active_overlay(app) {
        Some(w) => {
            eprintln!("[bentomux] overlay dismiss: destroying {}", w.label());
            let _ = w.destroy();
        }
        None => eprintln!("[bentomux] overlay dismiss: none active"),
    }
    *active_label().lock().unwrap() = None;
}

fn current_position(app: &AppHandle, w: f64, h: f64) -> (f64, f64) {
    /* center horizontally over the main window's monitor work area, anchored
    10px from the top of the screen — mirrors Electron's
    screen.getPrimaryDisplay().workArea math. */
    let win = app.get_webview_window("main");
    let (wx, wy, ww, wh) = match win {
        Some(w) if w.current_monitor().ok().flatten().is_some() => {
            let m = w.current_monitor().unwrap().unwrap();
            let size = m.size();
            let pos = m.position();
            let scale = w.scale_factor().unwrap_or(1.0);
            (
                pos.x as f64,
                pos.y as f64,
                size.width as f64 / scale as f64,
                size.height as f64 / scale as f64,
            )
        }
        _ => (0.0, 0.0, 1920.0, 1080.0),
    };
    let x = wx + (ww - w) / 2.0;
    let y = wy + (10.0f64).min(wh - h);
    (x.max(0.0), y.max(0.0))
}

fn pref_size(app: &AppHandle) -> (f64, f64) {
    let pref = app
        .state::<crate::state::AppStateManager>()
        .get_state()
        .prefs
        .approval_overlay;
    match pref {
        Some(p) if p.w >= OVERLAY_MIN_W && p.h >= OVERLAY_MIN_H => (p.w, p.h),
        _ => (OVERLAY_MIN_W, OVERLAY_MIN_H),
    }
}

/* create the overlay fresh for this request; reuse an existing one only when
its page is actually live. The page itself subscribes to `agent:approval`
(which the bridge already emits for every request) and renders it, so no
per-request payload is passed through the window URL. */
pub fn show_approval_overlay(app: &AppHandle) {
    let (w, h) = pref_size(app);
    let (x, y) = current_position(app, w, h);

    if let Some(existing) = active_overlay(app) {
        /* prefix match: the page appends render lifecycle info to the title */
        let healthy = existing
            .title()
            .map(|t| t.starts_with(READY_TITLE))
            .unwrap_or(false);
        eprintln!(
            "[bentomux] overlay show: existing label={} title={:?} healthy={healthy}",
            existing.label(),
            existing.title().unwrap_or_default()
        );
        if healthy {
            let _ = existing.set_position(LogicalPosition::new(x, y));
            let _ = existing.set_size(LogicalSize::new(w, h));
            /* show WITHOUT focusing — the overlay must never steal keyboard
            from the user's foreground app (Electron's showInactive) */
            let _ = existing.show();
            return;
        }
        /* dead shell: drop it and build a fresh window below */
        let _ = existing.destroy();
        *active_label().lock().unwrap() = None;
    }

    let label = format!("{}-{}", LABEL_PREFIX, SEQ.fetch_add(1, Ordering::Relaxed));
    eprintln!("[bentomux] overlay show: building fresh label={label}");
    let builder = WebviewWindowBuilder::new(app, &label, WebviewUrl::App(OVERLAY_PAGE.into()))
        .title("Bentomux — approval")
        .inner_size(w, h)
        .position(x, y)
        .min_inner_size(OVERLAY_MIN_W, OVERLAY_MIN_H)
        .decorations(false)
        .resizable(true)
        .skip_taskbar(true)
        /* never steals focus from the user's foreground app */
        .focused(false)
        .always_on_top(true)
        /* the island draws its own rounded frame over the desktop (carried
        over from the static config's transparent: true) */
        .transparent(true)
        .visible(false)
        /* show only once the page is actually painted — never a bare shell */
        .on_page_load(|window, payload| {
            if payload.event() == PageLoadEvent::Finished {
                eprintln!("[bentomux] overlay page finished, showing {}", window.label());
                let _ = window.show();
            }
        });

    match builder.build() {
        Ok(window) => {
            *active_label().lock().unwrap() = Some(label);
            /* persist resize (debounced by OS resize cadence) + keep centered */
            let app_resize = app.clone();
            let window_resize = window.clone();
            window.on_window_event(move |ev| {
                if let WindowEvent::Resized(_) = ev {
                    if let Ok(size) = window_resize.inner_size() {
                        let scale = window_resize.scale_factor().unwrap_or(1.0);
                        let w = size.width as f64 / scale;
                        let h = size.height as f64 / scale;
                        let state = app_resize.state::<crate::state::AppStateManager>();
                        state.patch_state(|s| {
                            s.prefs.approval_overlay = Some(crate::state::OverlaySize {
                                w: w.round(),
                                h: h.round(),
                            });
                        });
                        let (x, y) = current_position(&app_resize, w, h);
                        let _ = window_resize.set_position(LogicalPosition::new(x, y));
                    }
                }
            });
        }
        Err(e) => {
            /* do not crash the app if the window can't be created; the
            request is still visible in the main window / bridge. */
            eprintln!("[bentomux] approval overlay failed to open: {e}");
        }
    }
}
