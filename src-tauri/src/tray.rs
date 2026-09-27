/* System tray icon.

The app does not quit when its window is closed: `lib.rs` turns the
CloseRequested into a hide, and this module is what the user comes back
through. The icon lives in the notification area (Windows) / menu bar
(macOS); left click restores the window, right click opens a menu with
"Open Bentomux" and "Quit".

Quit deliberately matches the app's default exit: the pty host daemon and
every pane it owns keep running, so agents survive and the next launch
reattaches to them. Stopping panes for real stays where it always was —
Settings -> "Quit and stop all panes" (`app_quit(stopPanes=true)`). */

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use tauri::menu::{Menu, MenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Manager};

const TRAY_ID: &str = "bentomux-tray";
const MENU_OPEN: &str = "tray-open";
const MENU_QUIT: &str = "tray-quit";

/* Whether the tray icon exists. The close handler hides the window only when
it does: a hidden window with no tray icon would be unreachable, so a failed
tray build must leave close meaning quit. */
#[derive(Clone, Default)]
pub struct TrayState(pub Arc<AtomicBool>);

impl TrayState {
    pub fn is_up(&self) -> bool {
        self.0.load(Ordering::SeqCst)
    }
}

/* Restore the main window from the tray. Shared by the left-click handler and
the menu's Open item so both go through one path (unminimize -> show ->
focus, the same sequence the single-instance handler uses). */
pub fn show_main_window(app: &AppHandle) {
    if let Some(win) = app.get_webview_window("main") {
        let _ = win.unminimize();
        let _ = win.show();
        let _ = win.set_focus();
    }
}

/* Quit for real, leaving the pty host daemon and its panes running (the app's
documented default; see CLAUDE.md). `app.exit` runs the existing
RunEvent::ExitRequested cleanup — bridge, tunnel, remote, state flush. */
fn quit(app: &AppHandle) {
    app.exit(0);
}

pub fn init(app: &AppHandle) -> tauri::Result<()> {
    let open = MenuItem::with_id(app, MENU_OPEN, "Open Bentomux", true, None::<&str>)?;
    let quit_item = MenuItem::with_id(app, MENU_QUIT, "Quit", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&open, &quit_item])?;

    let mut builder = TrayIconBuilder::with_id(TRAY_ID)
        .menu(&menu)
        /* left click restores the window instead of opening the menu; the
        menu stays on right click, which is the platform convention */
        .show_menu_on_left_click(false)
        .tooltip("Bentomux")
        .on_menu_event(|app, event| match event.id().as_ref() {
            MENU_OPEN => show_main_window(app),
            MENU_QUIT => quit(app),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            /* Click carries both press and release; act on release so a
            press-and-hold does not fire early, and only for the left
            button — right click is the menu's. */
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                show_main_window(tray.app_handle());
            }
        });

    /* reuse the bundled app icon so the tray never needs its own asset */
    if let Some(icon) = app.default_window_icon().cloned() {
        builder = builder.icon(icon);
    }

    builder.build(app)?;
    if let Some(state) = app.try_state::<TrayState>() {
        state.0.store(true, Ordering::SeqCst);
    }
    Ok(())
}
