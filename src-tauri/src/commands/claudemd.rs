//! IPC commands for CLAUDE.md file detection and editing.

use serde::Serialize;

/// Status of CLAUDE.md file at project root.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClaudeMdStatus {
    pub exists: bool,
    pub path: String,
    pub content: Option<String>,
}

/// Resolves the path to CLAUDE.md, checking both the project root and `.claude/` subdirectory.
///
/// Claude Code supports CLAUDE.md in two locations:
/// 1. `<project>/CLAUDE.md` (traditional location)
/// 2. `<project>/.claude/CLAUDE.md` (new location supported since Claude Code v1.x)
///
/// Returns the root-level path if either doesn't exist, preferring root when both exist.
fn resolve_claude_md_path(canonical: &std::path::Path) -> std::path::PathBuf {
    let root_path = canonical.join("CLAUDE.md");
    if root_path.exists() {
        return root_path;
    }
    let dotclaude_path = canonical.join(".claude").join("CLAUDE.md");
    if dotclaude_path.exists() {
        return dotclaude_path;
    }
    // Default to root path when neither exists (used as target for new files)
    root_path
}

/// Check if CLAUDE.md exists at the project root or in `.claude/` and optionally return its content.
#[tauri::command]
pub async fn check_claude_md(project_path: String) -> Result<ClaudeMdStatus, String> {
    let canonical = std::fs::canonicalize(&project_path)
        .map_err(|e| format!("Invalid project path '{}': {}", project_path, e))?;

    let claude_md_path = resolve_claude_md_path(&canonical);
    let path_str = claude_md_path.to_string_lossy().into_owned();

    if claude_md_path.exists() {
        // Read content if file exists
        let content = tokio::fs::read_to_string(&claude_md_path)
            .await
            .ok();

        Ok(ClaudeMdStatus {
            exists: true,
            path: path_str,
            content,
        })
    } else {
        Ok(ClaudeMdStatus {
            exists: false,
            path: path_str,
            content: None,
        })
    }
}

/// Read CLAUDE.md content from project root or `.claude/` subdirectory.
#[tauri::command]
pub async fn read_claude_md(project_path: String) -> Result<String, String> {
    let canonical = std::fs::canonicalize(&project_path)
        .map_err(|e| format!("Invalid project path '{}': {}", project_path, e))?;

    let claude_md_path = resolve_claude_md_path(&canonical);

    tokio::fs::read_to_string(&claude_md_path)
        .await
        .map_err(|e| format!("Failed to read CLAUDE.md: {}", e))
}

/// Write content to CLAUDE.md, preserving the existing location (root or `.claude/`).
/// Creates a new file at the project root if neither location exists yet.
#[tauri::command]
pub async fn write_claude_md(project_path: String, content: String) -> Result<(), String> {
    let canonical = std::fs::canonicalize(&project_path)
        .map_err(|e| format!("Invalid project path '{}': {}", project_path, e))?;

    let claude_md_path = resolve_claude_md_path(&canonical);

    tokio::fs::write(&claude_md_path, content)
        .await
        .map_err(|e| format!("Failed to write CLAUDE.md: {}", e))
}
