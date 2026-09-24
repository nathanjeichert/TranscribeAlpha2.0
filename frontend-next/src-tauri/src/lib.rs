use rand::{distributions::Alphanumeric, Rng};
use std::io::{Read, Seek, SeekFrom};
use std::sync::Mutex;
use tauri::http::{header, Request, Response, StatusCode};
use tauri::{Emitter, Manager, State};
use tauri_plugin_fs::FsExt;
use tauri_plugin_shell::ShellExt;

const SIDECAR_PORT: u16 = 18080;

/// Safety cap for a single ranged read. Far above any MP4 metadata box a player asks for.
const MEDIA_MAX_RANGE_BYTES: u64 = 64 * 1024 * 1024;
/// Chunk returned for open-ended requests (`bytes=N-`); the player asks again for more.
const MEDIA_OPEN_RANGE_BYTES: u64 = 4 * 1024 * 1024;

struct SidecarChild(Mutex<Option<tauri_plugin_shell::process::CommandChild>>);
struct DesktopSessionToken(String);

#[tauri::command]
fn get_desktop_session_token(session: State<'_, DesktopSessionToken>) -> String {
    session.0.clone()
}

fn generate_session_token() -> String {
    rand::thread_rng()
        .sample_iter(&Alphanumeric)
        .take(48)
        .map(char::from)
        .collect()
}

#[cfg(unix)]
fn kill_zombie_sidecar() {
    let output = std::process::Command::new("lsof")
        .args(["-ti", &format!("tcp:{SIDECAR_PORT}")])
        .output();

    if let Ok(out) = output {
        let pids = String::from_utf8_lossy(&out.stdout);
        for pid_str in pids.split_whitespace() {
            if let Ok(pid) = pid_str.trim().parse::<i32>() {
                if pid <= 1 {
                    continue;
                }
                log::info!("[sidecar] killing zombie process {pid} on port {SIDECAR_PORT}");
                unsafe {
                    libc::kill(pid, libc::SIGTERM);
                }
            }
        }
        if !pids.trim().is_empty() {
            std::thread::sleep(std::time::Duration::from_millis(500));
        }
    }
}

#[cfg(windows)]
fn kill_zombie_sidecar() {
    let output = std::process::Command::new("cmd")
        .args([
            "/C",
            &format!("netstat -ano | findstr :{SIDECAR_PORT} | findstr LISTENING"),
        ])
        .output();

    if let Ok(out) = output {
        let text = String::from_utf8_lossy(&out.stdout);
        let mut killed = false;
        for line in text.lines() {
            if let Some(pid_str) = line.split_whitespace().last() {
                if let Ok(pid) = pid_str.parse::<u32>() {
                    if pid == 0 {
                        continue;
                    }
                    log::info!("[sidecar] killing zombie process {pid} on port {SIDECAR_PORT}");
                    let _ = std::process::Command::new("taskkill")
                        .args(["/F", "/PID", &pid.to_string()])
                        .output();
                    killed = true;
                }
            }
        }
        if killed {
            std::thread::sleep(std::time::Duration::from_millis(500));
        }
    }
}

async fn wait_for_sidecar_ready() -> bool {
    let client = reqwest::Client::new();
    let url = format!("http://127.0.0.1:{SIDECAR_PORT}/health");
    let max_attempts = 50;
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

/// Parses a single `Range: bytes=...` spec into an inclusive (start, end).
/// Only the first range of a multi-range header is honored. None = unsatisfiable.
fn parse_byte_range(value: &str, len: u64) -> Option<(u64, u64)> {
    let spec = value
        .trim()
        .strip_prefix("bytes=")?
        .split(',')
        .next()?
        .trim();
    let (start, end) = spec.split_once('-')?;
    let (start, end) = (start.trim(), end.trim());
    if len == 0 {
        return None;
    }
    if start.is_empty() {
        // Suffix range: the last N bytes.
        let suffix: u64 = end.parse().ok()?;
        if suffix == 0 {
            return None;
        }
        return Some((len.saturating_sub(suffix), len - 1));
    }
    let start: u64 = start.parse().ok()?;
    if start >= len {
        return None;
    }
    let end = if end.is_empty() {
        start + MEDIA_OPEN_RANGE_BYTES - 1
    } else {
        let end: u64 = end.parse().ok()?;
        if end < start {
            return None;
        }
        end
    };
    let end = end.min(len - 1).min(start + MEDIA_MAX_RANGE_BYTES - 1);
    Some((start, end))
}

/// `media://` protocol: streams local media files for <video>/<audio> playback.
///
/// Replaces Tauri's built-in `asset://` protocol for media, which truncates every
/// range response to ~1 MB. WebKit (macOS) requests each MP4 sample table in a single
/// range and silently drops the track when the reply comes back short, so any video
/// longer than ~90 minutes with its `moov` atom at the end played without audio.
/// This handler returns the full requested range, and reads off the main thread.
fn media_protocol_response<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    request: &Request<Vec<u8>>,
    origin: &str,
) -> Response<Vec<u8>> {
    let base = || {
        Response::builder()
            .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, origin)
            .header(header::ACCESS_CONTROL_EXPOSE_HEADERS, "content-range")
            .header(header::ACCEPT_RANGES, "bytes")
    };
    let status_only = |status: StatusCode| base().status(status).body(Vec::new()).unwrap();

    let raw_path = request.uri().path().trim_start_matches('/');
    let path = percent_encoding::percent_decode_str(raw_path)
        .decode_utf8_lossy()
        .to_string();
    if tauri::path::SafePathBuf::new(path.clone().into()).is_err()
        || !app.asset_protocol_scope().is_allowed(&path)
    {
        log::error!("media protocol refused path: {path}");
        return status_only(StatusCode::FORBIDDEN);
    }

    let mut file = match std::fs::File::open(&path) {
        Ok(file) => file,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            return status_only(StatusCode::NOT_FOUND)
        }
        Err(e) => {
            log::error!("media protocol failed to open {path}: {e}");
            return status_only(StatusCode::INTERNAL_SERVER_ERROR);
        }
    };

    let result = (|| -> std::io::Result<Response<Vec<u8>>> {
        let len = file.metadata()?.len();
        let mut magic = Vec::with_capacity(len.min(8192) as usize);
        (&mut file).take(8192).read_to_end(&mut magic)?;
        let mime = tauri::utils::mime_type::MimeType::parse(&magic, &path);
        let builder = base().header(header::CONTENT_TYPE, mime);

        let range = request
            .headers()
            .get(header::RANGE)
            .and_then(|v| v.to_str().ok());
        let (status, start, end) = match range {
            Some(value) => match parse_byte_range(value, len) {
                Some((start, end)) => (StatusCode::PARTIAL_CONTENT, start, end),
                None => {
                    return Ok(base()
                        .status(StatusCode::RANGE_NOT_SATISFIABLE)
                        .header(header::CONTENT_RANGE, format!("bytes */{len}"))
                        .body(Vec::new())
                        .unwrap())
                }
            },
            None => (StatusCode::OK, 0, len.saturating_sub(1)),
        };
        let nbytes = if len == 0 { 0 } else { end + 1 - start };

        let builder = builder
            .status(status)
            .header(header::CONTENT_LENGTH, nbytes);
        let builder = if status == StatusCode::PARTIAL_CONTENT {
            builder.header(header::CONTENT_RANGE, format!("bytes {start}-{end}/{len}"))
        } else {
            builder
        };
        if request.method() == tauri::http::Method::HEAD {
            return Ok(builder.body(Vec::new()).unwrap());
        }

        let mut buf = Vec::with_capacity(nbytes as usize);
        file.seek(SeekFrom::Start(start))?;
        file.take(nbytes).read_to_end(&mut buf)?;
        Ok(builder.body(buf).unwrap())
    })();

    result.unwrap_or_else(|e| {
        log::error!("media protocol failed to read {path}: {e}");
        status_only(StatusCode::INTERNAL_SERVER_ERROR)
    })
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
        .invoke_handler(tauri::generate_handler![get_desktop_session_token])
        .register_asynchronous_uri_scheme_protocol("media", |ctx, request, responder| {
            let app = ctx.app_handle().clone();
            let origin = app
                .get_webview_window(ctx.webview_label())
                .and_then(|webview| webview.url().ok())
                .map(|url| {
                    let port = url.port().map(|p| format!(":{p}")).unwrap_or_default();
                    format!(
                        "{}://{}{}",
                        url.scheme(),
                        url.host_str().unwrap_or_default(),
                        port
                    )
                })
                .unwrap_or_else(|| "null".into());
            tauri::async_runtime::spawn_blocking(move || {
                responder.respond(media_protocol_response(&app, &request, &origin));
            });
        })
        .setup(|app| {
            let fs_scope = app.fs_scope();
            let _ = fs_scope.allow_directory("/", true);

            kill_zombie_sidecar();

            let session_token = generate_session_token();
            app.manage(DesktopSessionToken(session_token.clone()));

            let sidecar_cmd = match app.shell().sidecar("transcribealpha-server") {
                Ok(cmd) => cmd.env("STANDALONE_SESSION_TOKEN", session_token),
                Err(e) => {
                    log::error!("Failed to create sidecar command: {e}");
                    app.manage(SidecarChild(Mutex::new(None)));
                    return Ok(());
                }
            };

            let (mut rx, child) = match sidecar_cmd.spawn() {
                Ok(result) => result,
                Err(e) => {
                    log::error!("Failed to spawn sidecar: {e}");
                    app.manage(SidecarChild(Mutex::new(None)));
                    return Ok(());
                }
            };

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

            app.manage(SidecarChild(Mutex::new(Some(child))));

            let app_handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                if !wait_for_sidecar_ready().await {
                    log::error!("[sidecar] backend did not start; transcription will fail");
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn byte_range_serves_full_explicit_range() {
        // A 1.4 MB sample-table request must not be truncated.
        assert_eq!(
            parse_byte_range("bytes=100-1418255", 5_000_000),
            Some((100, 1_418_255))
        );
        assert_eq!(parse_byte_range("bytes=0-1", 10), Some((0, 1)));
        assert_eq!(parse_byte_range("bytes=5-99", 10), Some((5, 9)));
    }

    #[test]
    fn byte_range_caps_open_and_huge_ranges() {
        let len = 3_000_000_000;
        assert_eq!(
            parse_byte_range("bytes=0-", len),
            Some((0, MEDIA_OPEN_RANGE_BYTES - 1))
        );
        assert_eq!(parse_byte_range("bytes=0-", 10), Some((0, 9)));
        assert_eq!(
            parse_byte_range(&format!("bytes=0-{}", len - 1), len),
            Some((0, MEDIA_MAX_RANGE_BYTES - 1))
        );
    }

    #[test]
    fn byte_range_suffix_and_invalid() {
        assert_eq!(parse_byte_range("bytes=-4", 10), Some((6, 9)));
        assert_eq!(parse_byte_range("bytes=-40", 10), Some((0, 9)));
        assert_eq!(parse_byte_range("bytes=0-3, 6-8", 10), Some((0, 3)));
        assert_eq!(parse_byte_range("bytes=10-", 10), None);
        assert_eq!(parse_byte_range("bytes=5-2", 10), None);
        assert_eq!(parse_byte_range("bytes=-0", 10), None);
        assert_eq!(parse_byte_range("items=0-1", 10), None);
        assert_eq!(parse_byte_range("bytes=0-1", 0), None);
    }
}
