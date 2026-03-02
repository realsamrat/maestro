use std::collections::HashMap;
use std::sync::Arc;

use serde::Serialize;
use tauri::{AppHandle, State};

use crate::core::session_manager::SessionManager;
use crate::core::status_server::StatusServer;
use crate::core::windows_process::TokioCommandExt;
use crate::core::{BackendCapabilities, BackendType, ProcessManager, PtyError, SessionProcessTree};

/// Backend information returned to the frontend.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackendInfo {
    /// The active backend type.
    pub backend_type: BackendType,
    /// Backend capabilities.
    pub capabilities: BackendCapabilitiesDto,
}

/// DTO for backend capabilities (frontend-friendly naming).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackendCapabilitiesDto {
    pub enhanced_state: bool,
    pub text_reflow: bool,
    pub kitty_graphics: bool,
    pub shell_integration: bool,
    pub backend_name: String,
}

impl From<BackendCapabilities> for BackendCapabilitiesDto {
    fn from(caps: BackendCapabilities) -> Self {
        Self {
            enhanced_state: caps.enhanced_state,
            text_reflow: caps.text_reflow,
            kitty_graphics: caps.kitty_graphics,
            shell_integration: caps.shell_integration,
            backend_name: caps.backend_name.to_string(),
        }
    }
}

/// Returns information about the active terminal backend.
///
/// The frontend can use this to enable/disable features based on
/// backend capabilities (e.g., enhanced terminal state queries).
#[tauri::command]
pub fn get_backend_info() -> BackendInfo {
    let backend_type = BackendType::platform_default();

    let capabilities = match backend_type {
        BackendType::XtermPassthrough => BackendCapabilities {
            enhanced_state: false,
            text_reflow: false,
            kitty_graphics: false,
            shell_integration: false,
            backend_name: "xterm-passthrough",
        },
        BackendType::VteParser => BackendCapabilities {
            enhanced_state: true,
            text_reflow: false,
            kitty_graphics: false,
            shell_integration: false,
            backend_name: "vte-parser",
        },
    };

    BackendInfo {
        backend_type,
        capabilities: capabilities.into(),
    }
}

/// Exposes `ProcessManager::spawn_shell` to the frontend.
///
/// Validates that `cwd` (if provided) exists and is a directory before
/// forwarding to the process manager. Returns the new session ID.
/// The frontend should listen on `pty-output-{id}` for shell output events.
///
/// # Environment Variables
/// The `env` parameter allows passing environment variables to the shell process.
/// These are inherited by all child processes (including Claude CLI → MCP server).
/// Common usage: `{ "MAESTRO_PROJECT_HASH": "<hash>" }` for MCP status identification.
/// Note: `MAESTRO_SESSION_ID` is automatically set by the process manager.
#[tauri::command]
pub async fn spawn_shell(
    app_handle: AppHandle,
    state: State<'_, ProcessManager>,
    cwd: Option<String>,
    env: Option<HashMap<String, String>>,
) -> Result<u32, PtyError> {
    // Validate cwd if provided: must exist and be a directory
    let canonical_cwd = if let Some(ref dir) = cwd {
        let path = std::path::Path::new(dir);
        let canonical = path
            .canonicalize()
            .map_err(|e| PtyError::spawn_failed(format!("Invalid cwd '{dir}': {e}")))?;
        if !canonical.is_dir() {
            return Err(PtyError::spawn_failed(format!(
                "cwd '{dir}' is not a directory"
            )));
        }
        // On Windows, canonicalize() prepends \\?\ (the Win32 extended-length
        // path prefix). cmd.exe treats that as a UNC path and refuses to use it
        // as a working directory, falling back to C:\Windows instead.
        // Strip the prefix so the shell receives a normal path.
        #[cfg(windows)]
        let canonical = {
            let s = canonical.to_string_lossy();
            match s.strip_prefix(r"\\?\") {
                Some(stripped) => std::path::PathBuf::from(stripped),
                None => canonical,
            }
        };

        Some(canonical.to_string_lossy().into_owned())
    } else {
        None
    };
    let pm = state.inner().clone();
    pm.spawn_shell(app_handle, canonical_cwd, env)
}

/// Exposes `ProcessManager::write_stdin` to the frontend.
/// Sends raw text (including control sequences like `\r`) to the PTY.
#[tauri::command]
pub async fn write_stdin(
    state: State<'_, ProcessManager>,
    session_id: u32,
    data: String,
) -> Result<(), PtyError> {
    let pm = state.inner().clone();
    pm.write_stdin(session_id, &data)
}

/// Exposes `ProcessManager::resize_pty` to the frontend.
/// Rejects dimensions that are zero or exceed 500 to prevent misuse.
#[tauri::command]
pub async fn resize_pty(
    state: State<'_, ProcessManager>,
    session_id: u32,
    rows: u16,
    cols: u16,
) -> Result<(), PtyError> {
    if rows == 0 || cols == 0 || rows > 500 || cols > 500 {
        return Err(PtyError::resize_failed("Invalid dimensions"));
    }
    let pm = state.inner().clone();
    pm.resize_pty(session_id, rows, cols)
}

/// Exposes `ProcessManager::kill_session` to the frontend.
/// Gracefully terminates the PTY session (SIGTERM, then SIGKILL after 3s).
/// Also unregisters the session from the status server.
#[tauri::command]
pub async fn kill_session(
    state: State<'_, ProcessManager>,
    session_mgr: State<'_, SessionManager>,
    status_server: State<'_, Arc<StatusServer>>,
    session_id: u32,
) -> Result<(), PtyError> {
    // Kill the PTY session
    let pm = state.inner().clone();
    let result = pm.kill_session(session_id).await;

    // Unregister the session from the status server so it stops accepting updates
    status_server.unregister_session(session_id).await;

    // Log for debugging
    let _project_path = session_mgr
        .all_sessions()
        .into_iter()
        .find(|s| s.id == session_id)
        .map(|s| s.project_path);

    result
}

/// Returns the process tree for a specific session.
///
/// The tree includes the root shell process and all its descendants.
/// Returns None if the session doesn't exist or its root process has exited.
#[tauri::command]
pub async fn get_session_process_tree(
    state: State<'_, ProcessManager>,
    session_id: u32,
) -> Result<Option<SessionProcessTree>, String> {
    let pm = state.inner().clone();
    let root_pid = match pm.get_session_pid(session_id) {
        Some(pid) => pid,
        None => return Ok(None),
    };

    Ok(crate::core::process_tree::get_process_tree(session_id, root_pid))
}

/// Returns process trees for all active sessions.
///
/// More efficient than calling get_session_process_tree for each session
/// since it only refreshes the process list once.
#[tauri::command]
pub async fn get_all_process_trees(
    state: State<'_, ProcessManager>,
) -> Result<Vec<SessionProcessTree>, String> {
    let pm = state.inner().clone();
    let sessions = pm.get_all_session_pids();
    Ok(crate::core::process_tree::get_all_process_trees(&sessions))
}

/// Kills a specific process by PID.
///
/// Sends SIGTERM first, waits up to 2 seconds, then SIGKILL if still alive.
/// Will refuse to kill root session processes (use kill_session for that).
#[tauri::command]
pub async fn kill_process(
    state: State<'_, ProcessManager>,
    pid: u32,
) -> Result<(), String> {
    let pm = state.inner().clone();
    let session_root_pids: Vec<i32> = pm
        .get_all_session_pids()
        .into_iter()
        .map(|(_, root_pid)| root_pid)
        .collect();

    crate::core::process_tree::kill_process(pid, &session_root_pids)
        .await
        .map_err(|e| e.to_string())
}

/// Saves image data from the frontend clipboard to a temporary file.
///
/// Called by the frontend when the user pastes an image into the terminal.
/// The image bytes are written to a temp file and the absolute path is returned
/// so the frontend can insert it into the terminal input for Claude to read.
#[tauri::command]
pub async fn save_pasted_image(data: Vec<u8>, media_type: String) -> Result<String, String> {
    const MAX_IMAGE_SIZE: usize = 50 * 1024 * 1024; // 50 MB
    if data.len() > MAX_IMAGE_SIZE {
        return Err(format!(
            "Image too large: {} bytes (max {MAX_IMAGE_SIZE})",
            data.len()
        ));
    }

    let extension = match media_type.as_str() {
        "image/png" => "png",
        "image/jpeg" | "image/jpg" => "jpg",
        "image/gif" => "gif",
        "image/webp" => "webp",
        "image/bmp" => "bmp",
        _ => {
            return Err(format!("Unsupported media type: {media_type}"));
        }
    };

    let filename = format!("maestro-paste-{}.{}", uuid::Uuid::new_v4(), extension);
    let path = std::env::temp_dir().join(filename);

    tokio::fs::write(&path, &data)
        .await
        .map_err(|e| format!("Failed to save pasted image: {e}"))?;

    log::info!("Saved pasted image to {}", path.display());
    Ok(path.to_string_lossy().into_owned())
}

/// Kills all active PTY sessions.
///
/// Used to clean up orphaned sessions when the frontend reloads.
/// Returns the number of sessions that were killed.
#[tauri::command]
pub async fn kill_all_sessions(state: State<'_, ProcessManager>) -> Result<u32, PtyError> {
    let pm = state.inner().clone();
    pm.kill_all_sessions().await
}

/// Returns the buffered PTY output (scrollback) for a session.
///
/// Called by the frontend on mount to restore terminal history after a WebView
/// reload. Returns an empty string if the session does not exist or has no
/// buffered output yet.
#[tauri::command]
pub async fn get_session_scrollback(
    session_id: u32,
    process_manager: State<'_, ProcessManager>,
) -> Result<String, String> {
    Ok(process_manager
        .get_session_scrollback(session_id)
        .unwrap_or_default())
}

/// Kills only PTY sessions whose child process is no longer alive.
///
/// Use this instead of `kill_all_sessions` on frontend startup so that live
/// sessions survive a WebView reload and can be reconnected. Also removes the
/// corresponding entries from the SessionManager to keep state consistent.
/// Returns the number of sessions cleaned up.
#[tauri::command]
pub async fn cleanup_dead_sessions(
    process_manager: State<'_, ProcessManager>,
    session_manager: State<'_, SessionManager>,
) -> Result<u32, String> {
    let dead_ids = process_manager.cleanup_dead_sessions().await;
    let count = dead_ids.len() as u32;
    for id in dead_ids {
        session_manager.remove_session(id);
    }
    if count > 0 {
        log::info!("cleanup_dead_sessions: removed {} dead session(s)", count);
    }
    Ok(count)
}

/// Checks if a command is available in the user's PATH.
///
/// On macOS/Linux, when the app is launched from GUI launchers (Raycast, Spotlight),
/// the PATH is minimal and doesn't include user installations. This function searches
/// common installation directories directly without spawning a shell (which can cause
/// issues with shell plugins like powerlevel10k).
///
/// On Windows, uses `where.exe` to check.

/// Resolves the full path of a CLI command by searching PATH and common installation directories.
/// Returns `None` if the command is not found.
/// Used by both `check_cli_available` and `enhance_prompt_with_claude`.
#[cfg(unix)]
fn resolve_cli_path(command: &str) -> Option<String> {
    let mut paths: Vec<String> = Vec::new();

    if let Ok(env_path) = std::env::var("PATH") {
        paths.extend(env_path.split(':').map(String::from));
    }

    if let Ok(home) = std::env::var("HOME") {
        paths.push("/opt/homebrew/bin".to_string());
        paths.push("/opt/homebrew/sbin".to_string());
        paths.push("/usr/local/bin".to_string());
        paths.push("/usr/local/sbin".to_string());
        paths.push(format!("{}/.npm-global/bin", home));
        paths.push(format!("{}/node_modules/.bin", home));
        paths.push(format!("{}/.cargo/bin", home));
        paths.push(format!("{}/go/bin", home));
        paths.push(format!("{}/.local/bin", home));
        paths.push(format!("{}/.pyenv/shims", home));
        paths.push(format!("{}/.rbenv/shims", home));
    }

    for dir in &paths {
        let cmd_path = format!("{}/{}", dir, command);
        if std::path::Path::new(&cmd_path).exists() {
            log::debug!("Found {} at {}", command, cmd_path);
            return Some(cmd_path);
        }
    }

    log::debug!("Command {} not found in PATH", command);
    None
}

#[tauri::command]
pub async fn check_cli_available(command: String) -> Result<bool, String> {
    #[cfg(unix)]
    {
        Ok(resolve_cli_path(&command).is_some())
    }

    #[cfg(windows)]
    {
        use crate::core::windows_process::TokioCommandExt;
        let output = tokio::process::Command::new("where.exe")
            .arg(&command)
            .hide_console_window()
            .output()
            .await
            .map_err(|e| format!("Failed to check CLI: {}", e))?;
        Ok(output.status.success())
    }
}

/// Enhances a pipeline task prompt using the local `claude` CLI in print mode (`-p`).
/// Uses the user's existing Claude Code subscription — no API key required.
/// Returns the improved prompt text, or an error string if enhancement fails.
#[tauri::command]
pub async fn enhance_prompt_with_claude(
    prompt: String,
    cwd: Option<String>,
) -> Result<String, String> {
    #[cfg(unix)]
    {
        let claude_path = resolve_cli_path("claude")
            .ok_or_else(|| "claude CLI not found — make sure Claude Code is installed".to_string())?;

        let meta_prompt = format!(
            "Improve this pipeline task prompt for a Claude AI coding agent working on a software project.\n\n\
Rules:\n\
- Keep the original intent intact — only clarify and expand\n\
- Add technical specifics if they are implied (framework, file paths, patterns to follow)\n\
- Add brief acceptance criteria if missing\n\
- Ensure it ends with: When done, call maestro_status(\"finished - <brief summary of what was done>\")\n\
- Return ONLY the improved prompt — no preamble, no explanations, no markdown fences\n\n\
Original prompt:\n\"\"\"\n{}\n\"\"\"",
            prompt
        );

        let mut cmd = tokio::process::Command::new(&claude_path);
        cmd.args(["--output-format", "text", "-p", &meta_prompt])
            .env("NO_COLOR", "1")
            .env("FORCE_COLOR", "0");

        if let Some(dir) = cwd {
            cmd.current_dir(dir);
        }

        let output = tokio::time::timeout(
            std::time::Duration::from_secs(60),
            cmd.output(),
        )
        .await
        .map_err(|_| "Enhancement timed out after 60s — claude may be slow or offline".to_string())?
        .map_err(|e| format!("Failed to run claude: {}", e))?;

        if output.status.success() {
            let text = String::from_utf8(output.stdout)
                .map_err(|e| format!("Invalid UTF-8 in claude output: {}", e))?;
            Ok(text.trim().to_string())
        } else {
            let stderr = String::from_utf8_lossy(&output.stderr);
            Err(format!("claude returned an error: {}", stderr.trim()))
        }
    }

    #[cfg(windows)]
    {
        Err("Prompt enhancement is not yet supported on Windows".to_string())
    }
}
