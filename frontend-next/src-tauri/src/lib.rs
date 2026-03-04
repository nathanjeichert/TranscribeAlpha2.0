use tauri::{Emitter, Manager};
use tauri_plugin_fs::FsExt;
use tauri_plugin_shell::ShellExt;

const SIDECAR_PORT: u16 = 18080;

/// Kill any existing process listening on the sidecar port.
/// Prevents zombie sidecars from previous app sessions blocking the new one.
fn kill_zombie_sidecar() {
    let output = std::process::Command::new("lsof")
        .args(["-ti", &format!("tcp:{SIDECAR_PORT}")])
        .output();

    if let Ok(out) = output {
        let pids = String::from_utf8_lossy(&out.stdout);
        for pid_str in pids.split_whitespace() {
            if let Ok(pid) = pid_str.trim().parse::<i32>() {
                if pid <= 1 { continue; } // never kill init/kernel or broadcast to process group
                log::info!("[sidecar] killing zombie process {pid} on port {SIDECAR_PORT}");
                unsafe { libc::kill(pid, libc::SIGTERM); }
            }
        }
        // Brief pause to let the port free up
        if !pids.trim().is_empty() {
            std::thread::sleep(std::time::Duration::from_millis(500));
        }
    }
}

/// Poll the sidecar /health endpoint until it responds or we time out.
async fn wait_for_sidecar_ready() -> bool {
    let client = reqwest::Client::new();
    let url = format!("http://127.0.0.1:{SIDECAR_PORT}/health");
    let max_attempts = 50; // 50 × 200ms = 10s max
    for i in 0..max_attempts {
        if let Ok(resp) = client.get(&url).send().await {
            if resp.status().is_success() {
                log::info!("[sidecar] ready after ~{}ms", i * 200);
                return true;
            }
        }
        tokio::time::sleep(std::time::Duration::from_millis(200)).await;
    }
    log::error!("[sidecar] failed to become ready within 10s");
    false
}

fn kill_sidecar(state: &SidecarChild) {
    if let Some(child) = state.0.lock().unwrap().take() {
        let _ = child.kill();
        log::info!("[sidecar] killed");
    }
}

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
            let _ = fs_scope.allow_directory("/", true);

            // Kill any leftover sidecar from a previous session
            kill_zombie_sidecar();

            let sidecar_cmd = match app.shell().sidecar("transcribealpha-server") {
                Ok(cmd) => cmd,
                Err(e) => {
                    log::error!("Failed to create sidecar command: {e}");
                    app.manage(SidecarChild(std::sync::Mutex::new(None)));
                    return Ok(());
                }
            };

            let (mut rx, child) = match sidecar_cmd.spawn() {
                Ok(result) => result,
                Err(e) => {
                    log::error!("Failed to spawn sidecar: {e}");
                    app.manage(SidecarChild(std::sync::Mutex::new(None)));
                    return Ok(());
                }
            };

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

            // Wait for sidecar to be ready before the UI starts making requests
            let app_handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                if !wait_for_sidecar_ready().await {
                    log::error!("[sidecar] backend did not start — transcription will fail");
                    // Emit an event the frontend can listen for if needed
                    let _ = app_handle.emit("sidecar-status", "failed");
                } else {
                    let _ = app_handle.emit("sidecar-status", "ready");
                }
            });

            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::Destroyed = event {
                if let Some(state) = window.try_state::<SidecarChild>() {
                    kill_sidecar(state.inner());
                }
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

struct SidecarChild(std::sync::Mutex<Option<tauri_plugin_shell::process::CommandChild>>);
