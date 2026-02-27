use tauri::Manager;
use tauri_plugin_fs::FsExt;
use tauri_plugin_shell::ShellExt;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_store::Builder::new().build())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .setup(|app| {
            // Allow full filesystem access so the user can pick any workspace folder
            let fs_scope = app.fs_scope();
            fs_scope.allow_directory("/", true);

            let sidecar = app
                .shell()
                .sidecar("transcribealpha-server")
                .expect("failed to create sidecar command");

            let (mut rx, child) = sidecar.spawn().expect("failed to spawn sidecar");

            // Log sidecar stdout/stderr in a background task
            tauri::async_runtime::spawn(async move {
                use tauri_plugin_shell::process::CommandEvent;
                while let Some(event) = rx.recv().await {
                    match event {
                        CommandEvent::Stdout(line) => {
                            let line = String::from_utf8_lossy(&line);
                            log::info!("[sidecar] {}", line.trim());
                        }
                        CommandEvent::Stderr(line) => {
                            let line = String::from_utf8_lossy(&line);
                            log::warn!("[sidecar] {}", line.trim());
                        }
                        CommandEvent::Terminated(status) => {
                            log::info!("[sidecar] terminated with {:?}", status);
                            break;
                        }
                        CommandEvent::Error(err) => {
                            log::error!("[sidecar] error: {}", err);
                            break;
                        }
                        _ => {}
                    }
                }
            });

            // Store child handle so we can kill the sidecar on exit
            app.manage(SidecarChild(std::sync::Mutex::new(Some(child))));

            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::Destroyed = event {
                if let Some(state) = window.try_state::<SidecarChild>() {
                    if let Some(child) = state.0.lock().unwrap().take() {
                        let _ = child.kill();
                        log::info!("[sidecar] killed on window destroy");
                    }
                }
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

struct SidecarChild(std::sync::Mutex<Option<tauri_plugin_shell::process::CommandChild>>);
