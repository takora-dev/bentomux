/* ---------------- macOS application menu ----------------
Tauri installs a default app menu on macOS (`Menu::default`) whose
File > Close Window and Window > Close Window items bind Cmd+W to the native
"close this window" action. In Bentomux closing the window means hiding to
the tray, so Cmd+W did the one thing it should never do: make the app
disappear.

This module rebuilds that menu without the Close Window items and puts
File > Close Pane on Cmd+W instead. The item carries no behaviour of its own:
its menu event is forwarded to the renderer (see `CLOSE_PANE_ID`), which
closes the focused pane, or the whole tab when only one pane is left.

Every other entry stays a predefined item, so Quit, Hide, cut/copy/paste,
Zoom and the Window/Help menu handling are exactly what the platform
provides. Only macOS builds the menu: Windows/Linux have no app menu. */

use tauri::menu::{
    AboutMetadata, Menu, MenuItem, PredefinedMenuItem, Submenu, HELP_SUBMENU_ID, WINDOW_SUBMENU_ID,
};
use tauri::AppHandle;

/* File > Close Pane. The renderer subscribes to this id being emitted, not
to the keypress — the accelerator never reaches the webview. */
pub const CLOSE_PANE_ID: &str = "menu-close-pane";

pub fn build(app: &AppHandle) -> tauri::Result<Menu<tauri::Wry>> {
    let pkg_info = app.package_info();
    let config = app.config();
    let about_metadata = AboutMetadata {
        name: Some(pkg_info.name.clone()),
        version: Some(pkg_info.version.to_string()),
        copyright: config.bundle.copyright.clone(),
        authors: config.bundle.publisher.clone().map(|p| vec![p]),
        ..Default::default()
    };

    let close_pane = MenuItem::with_id(
        app,
        CLOSE_PANE_ID,
        "Close Pane",
        true,
        Some("CmdOrCtrl+W"),
    )?;

    Menu::with_items(
        app,
        &[
            &Submenu::with_items(
                app,
                pkg_info.name.clone(),
                true,
                &[
                    &PredefinedMenuItem::about(app, None, Some(about_metadata))?,
                    &PredefinedMenuItem::separator(app)?,
                    &PredefinedMenuItem::services(app, None)?,
                    &PredefinedMenuItem::separator(app)?,
                    &PredefinedMenuItem::hide(app, None)?,
                    &PredefinedMenuItem::hide_others(app, None)?,
                    &PredefinedMenuItem::separator(app)?,
                    &PredefinedMenuItem::quit(app, None)?,
                ],
            )?,
            /* the only departure from the default menu: Close Pane instead of
            Close Window */
            &Submenu::with_items(app, "File", true, &[&close_pane])?,
            &Submenu::with_items(
                app,
                "Edit",
                true,
                &[
                    &PredefinedMenuItem::undo(app, None)?,
                    &PredefinedMenuItem::redo(app, None)?,
                    &PredefinedMenuItem::separator(app)?,
                    &PredefinedMenuItem::cut(app, None)?,
                    &PredefinedMenuItem::copy(app, None)?,
                    &PredefinedMenuItem::paste(app, None)?,
                    &PredefinedMenuItem::select_all(app, None)?,
                ],
            )?,
            &Submenu::with_items(
                app,
                "View",
                true,
                &[&PredefinedMenuItem::fullscreen(app, None)?],
            )?,
            &Submenu::with_id_and_items(
                app,
                WINDOW_SUBMENU_ID,
                "Window",
                true,
                &[
                    &PredefinedMenuItem::minimize(app, None)?,
                    &PredefinedMenuItem::maximize(app, None)?,
                ],
            )?,
            /* empty on macOS; declared so the platform still finds and marks
            a Help menu (see tauri::init_app_menu) */
            &Submenu::with_id(app, HELP_SUBMENU_ID, "Help", true)?,
        ],
    )
}
