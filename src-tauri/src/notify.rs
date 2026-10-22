/* Native notification delivery.

macOS has two ways to talk to usernoted: the legacy NSUserNotification API
(mac-notification-sys and the Tauri plugin both use it) and the modern
UNUserNotificationCenter. A process may use only one of them - mixing makes
usernoted deny every legacy send with "You can't mix modern clients with
legacy clients" - and the permission check has to be modern, so delivery is
modern too whenever the executable lives in a bundle. */

#[cfg(target_os = "macos")]
mod delegate {
    use block2::DynBlock;
    use objc2::rc::Retained;
    use objc2::runtime::{NSObject, NSObjectProtocol, ProtocolObject};
    use objc2::{define_class, msg_send, AllocAnyThread};
    use objc2_user_notifications::{
        UNNotification, UNNotificationPresentationOptions, UNUserNotificationCenter,
        UNUserNotificationCenterDelegate,
    };
    use std::sync::OnceLock;

    define_class!(
        /* AppKit hands a foreground app's notification to its delegate instead
           of showing it. Without one macOS accepts the request and then
           presents nothing, which looks exactly like a broken feature. */
        #[unsafe(super(NSObject))]
        #[name = "BentomuxNotificationDelegate"]
        #[ivars = ()]
        struct NotificationDelegate;

        unsafe impl NSObjectProtocol for NotificationDelegate {}

        unsafe impl UNUserNotificationCenterDelegate for NotificationDelegate {
            #[unsafe(method(userNotificationCenter:willPresentNotification:withCompletionHandler:))]
            fn will_present(
                &self,
                _center: &UNUserNotificationCenter,
                _notification: &UNNotification,
                completion_handler: &DynBlock<dyn Fn(UNNotificationPresentationOptions)>,
            ) {
                completion_handler.call((UNNotificationPresentationOptions::Banner
                    | UNNotificationPresentationOptions::List
                    | UNNotificationPresentationOptions::Sound,));
            }
        }
    );

    static DELEGATE: OnceLock<Retained<NotificationDelegate>> = OnceLock::new();

    /* the centre holds the delegate weakly, so it lives in a static */
    pub fn install(center: &UNUserNotificationCenter) {
        let delegate = DELEGATE.get_or_init(|| unsafe {
            let alloc = NotificationDelegate::alloc();
            msg_send![alloc, init]
        });
        center.setDelegate(Some(ProtocolObject::from_ref(&**delegate)));
    }
}

/* The bundle test, split out so it can be checked without a live bundle. */
#[cfg(any(target_os = "macos", test))]
fn modern_path_allowed(bundle_path: &str, has_identifier: bool) -> bool {
    bundle_path.ends_with(".app") && has_identifier
}

/* Whether this process may use the modern UNUserNotificationCenter client.
   Only a real .app bundle may: macOS raises an ObjC exception otherwise (and
   a throw unwinding into Rust is a hard crash - the reported SIGSEGV in
   _Unwind_RaiseException under NSAssertionHandler).
   A bundle identifier alone does not prove a bundle: tauri-build embeds the
   Info.plist in the binary (__TEXT,__info_plist), so the bare target/debug
   binary that `tauri dev` runs reports CFBundleIdentifier just like the
   installed app does. Only the bundle path tells them apart.
   The process must also stick to one client: macOS refuses to mix the legacy
   NSUserNotification client with the modern centre, and the mix raises too. */
#[cfg(target_os = "macos")]
pub fn modern_client() -> bool {
    use objc2_foundation::NSBundle;
    let bundle = NSBundle::mainBundle();
    modern_path_allowed(
        &bundle.bundlePath().to_string(),
        bundle.bundleIdentifier().is_some(),
    )
}

/* The legacy client never talks to the modern UserNotifications daemon, so it
   is safe outside a bundle. It can still raise, so it gets the same fence. */
#[cfg(target_os = "macos")]
fn legacy_send(title: &str, body: &str) -> Result<(), String> {
    let sent = objc2::exception::catch(std::panic::AssertUnwindSafe(|| {
        let mut options = mac_notification_sys::Notification::new();
        options.default_sound();
        mac_notification_sys::send_notification(title, None, body, Some(&options))
            .map(|_| ())
            .map_err(|e| e.to_string())
    }));
    match sent {
        Ok(result) => result,
        Err(_) => Err("the legacy notification client raised".to_string()),
    }
}

/* Set the foreground presentation delegate once, before the first send. */
#[cfg(target_os = "macos")]
pub fn install() {
    if !modern_client() {
        return;
    }
    /* an exception raised here would escape into the Tauri setup hook and take
    the process with it */
    let installed = objc2::exception::catch(std::panic::AssertUnwindSafe(|| {
        delegate::install(
            &objc2_user_notifications::UNUserNotificationCenter::currentNotificationCenter(),
        );
    }));
    if installed.is_err() {
        eprintln!("[bentomux] notification delegate install raised; notifications stay legacy");
    }
}

/* tauri dev runs the bare binary: no bundle, and UserNotifications kills the
   process without one, so dev keeps the legacy path (nothing opens a modern
   client there, so the two never meet in one process). */
#[cfg(target_os = "macos")]
pub fn send(_app: &tauri::AppHandle, title: &str, body: &str) -> Result<(), String> {
    if !modern_client() {
        return legacy_send(title, body);
    }
    use block2::RcBlock;
    use objc2_foundation::{NSError, NSString};
    use objc2_user_notifications::{
        UNMutableNotificationContent, UNNotificationRequest, UNNotificationSound,
        UNUserNotificationCenter,
    };
    use std::sync::mpsc;
    use std::time::Duration;

    let content = UNMutableNotificationContent::new();
    content.setTitle(&NSString::from_str(title));
    content.setBody(&NSString::from_str(body));
    content.setSound(Some(&UNNotificationSound::defaultSound()));
    let id = format!(
        "bentomux-{}",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0)
    );
    let request = UNNotificationRequest::requestWithIdentifier_content_trigger(
        &NSString::from_str(&id),
        &content,
        None,
    );

    let (tx, rx) = mpsc::channel::<Option<String>>();
    let block: RcBlock<dyn Fn(*mut NSError)> = RcBlock::new(move |error: *mut NSError| {
        let message = unsafe { error.as_ref() }.map(|e| e.localizedDescription().to_string());
        let _ = tx.send(message);
    });
    /* `+[UNUserNotificationCenter currentNotificationCenter]` raises an ObjC
    exception when the process is not a registered .app bundle, and a throw
    unwinding into Rust is a hard crash (the reported SIGSEGV: _Unwind_RaiseException
    <- __cxa_throw <- objc_exception_throw <- NSAssertionHandler).
    `catch_unwind` cannot see ObjC exceptions, so fence the modern path with
    objc2::exception::catch and fall back to the legacy client. */
    let sent = objc2::exception::catch(std::panic::AssertUnwindSafe(|| {
        let center = UNUserNotificationCenter::currentNotificationCenter();
        delegate::install(&center);
        center.addNotificationRequest_withCompletionHandler(&request, Some(&block));
        rx.recv_timeout(Duration::from_secs(5))
    }));
    match sent {
        Ok(Ok(Some(e))) => Err(e),
        Ok(_) => Ok(()),
        Err(_) => {
            eprintln!(
                "[bentomux] modern notification path raised; falling back to the legacy client"
            );
            legacy_send(title, body)
        }
    }
}

#[cfg(not(target_os = "macos"))]
pub fn send(app: &tauri::AppHandle, title: &str, body: &str) -> Result<(), String> {
    use tauri_plugin_notification::NotificationExt;
    app.notification()
        .builder()
        .title(title)
        .body(body)
        .show()
        .map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::modern_path_allowed;

    /* The trap this guards: tauri-build embeds the Info.plist in the binary,
    so the bare target/debug binary that `tauri dev` runs reports a bundle
    identifier. Only the .app path says whether the process really is a
    bundle, and UserNotifications raises (killing the app) when it is not. */
    #[test]
    fn only_a_real_app_bundle_may_use_the_modern_notifications() {
        assert!(modern_path_allowed("/Applications/Bentomux.app", true));
        assert!(!modern_path_allowed(
            "/Users/me/app/src-tauri/target/debug",
            true
        ));
        assert!(!modern_path_allowed(
            "/Users/me/app/src-tauri/target/debug",
            false
        ));
    }

    /* The same check against a real process: the test binary carries the
    embedded Info.plist (bundle identifier present) but lives in
    target/debug/deps, so it must not be treated as a bundle. */
    #[cfg(target_os = "macos")]
    #[test]
    fn a_binary_with_an_embedded_plist_is_not_a_bundle() {
        use objc2_foundation::NSBundle;
        let bundle = NSBundle::mainBundle();
        /* the embedded plist is only read for a real bundle, so the identifier
        may be absent here - either way this process is not a bundle */
        assert!(!super::modern_client());
        let _ = bundle.bundleIdentifier();
    }
}
