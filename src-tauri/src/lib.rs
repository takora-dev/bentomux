// Bentomux Tauri backend library root.
// Modules are ported phase-by-phase from the Electron main process
// (see MIGRATION_TO_TAURI.md). Phase 1 creates the skeleton; each
// module gains its implementation in its dedicated phase.

pub mod agent_hooks;
pub mod agents;
pub mod bridge;
pub mod bridge_config;
pub mod commands;
pub mod detect;
pub mod git;
pub mod overlay;
pub mod plugin;
pub mod pty;
pub mod pty_host;
pub mod remote;
pub mod runtime;
pub mod shell;
pub mod split_tree;
pub mod state;
pub mod terminal;
pub mod tray;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let process_start = std::time::Instant::now();
    // Build AppStateManager before the Tauri Builder so it can be registered
    // via builder.manage() — state is then available before WebView2
    // initialises, making the Windows "state not managed" boot error impossible.
    let app_state = state::AppStateManager::new(state::AppStateManager::pre_build_path());
    // Same reason for the pty manager: Tauri creates the window (and WebView2,
    // which starts dispatching IPC) inside setup(), before the app's own setup
    // closure runs. Managing it there left a window where `tab_restore` could
    // arrive before `.manage(pty)` — the "state not managed for field `pty`"
    // boot error. Construction here is I/O-free; the daemon handshake runs in
    // start(), below, and commands that arrive meanwhile wait on its gate.
    let pty_manager = pty::PtyManager::new();
    /* safe mode is decided before the webview exists: if it engages, the
    renderer must know from its very first paint so it can skip plugin
    activation instead of racing the banner */
    let boot_report = plugin::boot::begin_boot(&app_state, plugin::boot::requested_on_cli());
    if boot_report.safe_mode {
        eprintln!(
            "[bentomux] safe mode: third-party plugins disabled (attempt {}, requested={})",
            boot_report.attempts, boot_report.requested
        );
    }
    app_state.patch_state(|s| {
        s.safe_mode = boot_report.safe_mode;
        s.boot_attempts = boot_report.attempts;
    });
    let mut builder = tauri::Builder::default();
    builder = builder
        /* plugin assets: `plugin://<id>/<path>` (see docs/adr/0003) */
        .register_asynchronous_uri_scheme_protocol(plugin::scheme::SCHEME, |ctx, req, responder| {
            plugin::scheme::handle(ctx, req, responder);
        })
        /* must be the first plugin: a second launch has to bail out before it
        touches the store or the pty host daemon */
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            use tauri::Manager;
            if let Some(win) = app.get_webview_window("main") {
                let _ = win.unminimize();
                let _ = win.show();
                let _ = win.set_focus();
            }
        }))
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_opener::init())
        .manage(app_state)
        .manage(pty_manager);
    builder = builder.setup(move |app| {
        eprintln!(
            "[perf] backend-ready-ms={}",
            process_start.elapsed().as_millis()
        );
        use tauri::Emitter;
        use tauri::Manager;
        let handle = app.handle().clone();
        /* connect to (or spawn) the pty host daemon. Runs first because it is
        the slowest step, and any IPC command that arrives meanwhile waits
        on the manager's ready gate instead of failing. */
        app.state::<pty::PtyManager>().start(handle.clone());
        commands::cleanup_clipboard_temp_files();
        git::init_watch(handle.clone());
        /* boot-time remote restore: mirrors Electron's index.ts startRemote()
        call when prefs.remote.enabled was persisted true from a prior
        session — otherwise the panel shows "On" but never actually starts. */
        remote::restore_on_startup(&handle, app.state::<state::AppStateManager>().inner());
        /* keeps a public tunnel up when cloudflared exits on its own */
        remote::spawn_tunnel_watchdog(&handle);
        /* agent runtime detection: headless screen feed + process poller */
        runtime::init(handle.clone());
        /* approval bridge: unix socket the managed agent hooks write to */
        bridge::start_bridge(handle.clone(), &app.state::<pty::PtyManager>());
        /* bundled plugins: install or refresh the ones shipped with this
        build. Runs in setup so the resource dir can be resolved, and
        before the renderer's first plugin_list, so the registry is
        complete when the UI asks for it. */
        {
            let paths = plugin::registry::PluginPaths::new(
                &app.path()
                    .app_data_dir()
                    .unwrap_or_else(|_| std::path::PathBuf::from(".")),
            );
            let bundled = app
                .path()
                .resolve(
                    "../resources/plugin-bundled",
                    tauri::path::BaseDirectory::Resource,
                )
                .ok()
                .filter(|d| d.is_dir());
            if let Some(dir) = bundled {
                let paths = paths.with_bundled(dir);
                let mgr = app.state::<state::AppStateManager>();
                let mut errors = Vec::new();
                mgr.patch_state(|s| {
                    errors = plugin::registry::sync_bundled(&paths, &mut s.plugins);
                });
                for e in errors {
                    eprintln!("[bentomux] bundled plugin sync: {}", e);
                }
            }
        }
        /* system tray: the icon the app hides behind when its window is
        closed, and the only way back (plus the Quit menu item). Built here
        rather than in tauri.conf.json so the icon can reuse the bundled
        app icon. TrayState records whether it came up, which the close
        handler below consults before hiding. */
        app.manage(tray::TrayState::default());
        if let Err(e) = tray::init(&handle) {
            eprintln!("[bentomux] tray icon failed to init: {e}");
        }
        /* track the last-known maximize state on the main window so we only
        emit `win:maximized` on the actual OS transition (mirrors
        Electron's `win.on('maximize'/'unmaximize')` pattern in
        src/main/window.ts). The AtomicBool is shared between the
        setup-time window event handler and win_toggle_maximize. */
        if let Some(main) = app.get_webview_window("main") {
            let last_max = Arc::new(AtomicBool::new(main.is_maximized().unwrap_or(false)));
            app.manage(WindowMaxState(last_max.clone()));
            let last_full = Arc::new(AtomicBool::new(main.is_fullscreen().unwrap_or(false)));
            app.manage(WindowFullState(last_full.clone()));
            let app_for_event = handle.clone();
            let last_for_event = last_max.clone();
            let last_full_for_event = last_full.clone();
            let main_for_event = main.clone();
            main.on_window_event(move |ev| match ev {
                tauri::WindowEvent::Resized(_) => {
                    let now = main_for_event.is_maximized().unwrap_or(false);
                    let prev = last_for_event.swap(now, Ordering::SeqCst);
                    if now != prev {
                        let _ = app_for_event.emit("win:maximized", now);
                    }
                    /* same transition guard for fullscreen: the renderer
                    flips its `html.fullscreen` class on this event (macOS
                    fullscreen hides the traffic lights, so the side-tools
                    reflow). Covers both the app toggle and the native
                    green-button / Ctrl+Cmd+F transitions. */
                    let now_full = main_for_event.is_fullscreen().unwrap_or(false);
                    let prev_full = last_full_for_event.swap(now_full, Ordering::SeqCst);
                    if now_full != prev_full {
                        let _ = app_for_event.emit("win:fullscreen", now_full);
                    }
                }
                tauri::WindowEvent::CloseRequested { api, .. } => {
                    /* Closing the window does NOT quit: the app keeps
                    running in the background with its tray icon, so
                    agents, the approval bridge and the remote monitor
                    stay alive. Quit for real goes through the tray's
                    Quit item or app_quit(), both of which call
                    app.exit(0) and land on the ExitRequested cleanup
                    below.

                    The hide is gated on the tray actually existing: with
                    no icon there would be no way back, so a failed tray
                    build leaves close meaning quit. */
                    let tray_up = app_for_event
                        .try_state::<tray::TrayState>()
                        .map(|s| s.is_up())
                        .unwrap_or(false);
                    if tray_up {
                        api.prevent_close();
                        let _ = main_for_event.hide();
                    } else {
                        eprintln!("[bentomux] tray unavailable; closing the window quits the app");
                        app_for_event.exit(0);
                    }
                }
                _ => {}
            });
        }

        Ok(())
    });
    builder
        .invoke_handler(tauri::generate_handler![
            commands::get_state,
            commands::prefs_update,
            commands::workspace_choose,
            commands::workspace_add,
            commands::workspace_remove,
            commands::workspace_reorder,
            commands::workspace_active,
            commands::tab_reorder,
            commands::tab_restore,
            commands::tab_create,
            commands::tab_split,
            commands::tab_rename,
            commands::tab_set_dir,
            commands::tab_close_pane,
            commands::tab_close,
            commands::pty_write,
            commands::pty_resize,
            commands::git_status,
            commands::git_diff,
            commands::git_diff_stat,
            commands::git_push,
            commands::git_remote_info,
            commands::git_history,
            commands::git_show,
            commands::git_branch_for,
            commands::agents_list,
            commands::agents_config,
            commands::agents_set_model_settings,
            commands::agent_hooks_status,
            commands::agent_hooks_install,
            commands::agent_hooks_uninstall,
            commands::agent_approval_resolve,
            commands::agent_approval_pending,
            commands::agent_approval_hide,
            commands::agent_set_active_tab,
            commands::res_list,
            commands::res_save,
            commands::res_delete,
            commands::res_toggle,
            commands::remote_info,
            commands::remote_set_enabled,
            commands::remote_set_port,
            commands::win_minimize,
            commands::win_toggle_maximize,
            commands::win_toggle_fullscreen,
            commands::win_close,
            commands::app_quit,
            commands::shutdown_for_update,
            commands::temp_write_file,
            plugin::commands::plugin_list,
            plugin::commands::plugin_choose_folder,
            plugin::commands::plugin_choose_zip,
            plugin::commands::plugin_choose_new_folder,
            plugin::commands::plugin_templates,
            plugin::commands::plugin_scaffold,
            plugin::commands::plugin_skill_targets,
            plugin::commands::plugin_install_skill,
            plugin::commands::plugin_validate,
            plugin::commands::plugin_manifest,
            plugin::commands::plugin_install_folder,
            plugin::commands::plugin_install_zip,
            plugin::commands::plugin_install_url,
            plugin::commands::plugin_set_enabled,
            plugin::commands::plugin_update,
            plugin::commands::plugin_rollback,
            plugin::commands::plugin_uninstall,
            plugin::commands::plugin_data_get,
            plugin::commands::plugin_data_set,
            plugin::commands::plugin_data_delete,
            plugin::commands::plugin_data_keys,
            plugin::commands::plugin_safe_mode,
            plugin::commands::plugin_report_ready,
            plugin::commands::plugin_leave_safe_mode,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|_app, event| {
            /* ensure pending hook connections are closed on exit so agent
            PermissionRequests don't hang waiting for our directive
            (port of Electron's before-quit → stopBridge in bridge.ts).

            The panes are deliberately NOT killed here: they belong to the
            pty host daemon, so quitting leaves the agent CLIs running and
            the next launch reattaches to them. */
            if let tauri::RunEvent::ExitRequested { .. } = event {
                bridge::stop_bridge();
                crate::remote::stop_tunnel();
                {
                    crate::remote::stop_remote();
                }
                /* flush the debounced state writer: the last ~400 ms of
                patches would otherwise never reach bentomux.json */
                {
                    use tauri::Manager;
                    if let Some(mgr) = _app.try_state::<crate::state::AppStateManager>() {
                        mgr.flush();
                    }
                }
            }
        });
}

/* shared maximize-state guard; `win_toggle_maximize` reads/swaps it after
the OS toggle and emits the event so the renderer's `onMaximized` cb
fires on programmatic toggles too (Electron parity). */
pub struct WindowMaxState(pub Arc<AtomicBool>);

/* shared fullscreen-state guard; `win_toggle_fullscreen` reads/swaps it after
the OS toggle so the Resized handler does not double-emit the same
transition (same pattern as WindowMaxState). */
pub struct WindowFullState(pub Arc<AtomicBool>);
