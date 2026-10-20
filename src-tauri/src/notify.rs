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

#[cfg(target_os = "macos")]
fn in_bundle() -> bool {
    use objc2_foundation::NSBundle;
    NSBundle::mainBundle().bundleIdentifier().is_some()
}

/* Set the foreground presentation delegate once, before the first send. */
#[cfg(target_os = "macos")]
pub fn install() {
    if in_bundle() {
        delegate::install(
            &objc2_user_notifications::UNUserNotificationCenter::currentNotificationCenter(),
        );
    }
}

/* tauri dev runs the bare binary: no bundle id, and UserNotifications aborts
   the process without one, so dev keeps the legacy path (nothing opens a
   modern client there, so the two never meet in one process). */
#[cfg(target_os = "macos")]
pub fn send(_app: &tauri::AppHandle, title: &str, body: &str) -> Result<(), String> {
    if !in_bundle() {
        return mac_notification_sys::send_notification(title, None, body, None)
            .map(|_| ())
            .map_err(|e| e.to_string());
    }
    use block2::RcBlock;
    use objc2_foundation::{NSError, NSString};
    use objc2_user_notifications::{
        UNMutableNotificationContent, UNNotificationRequest, UNUserNotificationCenter,
    };
    use std::sync::mpsc;
    use std::time::Duration;

    let content = UNMutableNotificationContent::new();
    content.setTitle(&NSString::from_str(title));
    content.setBody(&NSString::from_str(body));
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
    let center = UNUserNotificationCenter::currentNotificationCenter();
    delegate::install(&center);
    center.addNotificationRequest_withCompletionHandler(&request, Some(&block));
    match rx.recv_timeout(Duration::from_secs(5)) {
        Ok(Some(e)) => Err(e),
        _ => Ok(()),
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
