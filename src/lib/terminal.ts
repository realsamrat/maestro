/**
 * Thin wrappers around Tauri `invoke` / `listen` for PTY session management.
 *
 * Each function maps 1:1 to a Rust `#[tauri::command]` handler. Errors are
 * propagated as rejected promises; callers are responsible for catch/logging.
 */

import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { BackendCapabilities, BackendType } from "./terminalTheme";

/**
 * Spawns a new PTY shell session on the backend.
 * @param cwd - Starting working directory; when omitted the backend uses its default.
 * @param env - Environment variables to pass to the shell process. These are inherited
 *   by all child processes (including Claude CLI → MCP server). MAESTRO_SESSION_ID is
 *   automatically set by the backend.
 * @returns The numeric session ID assigned by the backend.
 */
export async function spawnShell(cwd?: string, env?: Record<string, string>): Promise<number> {
  return invoke<number>("spawn_shell", { cwd: cwd ?? null, env: env ?? null });
}

/** Saves pasted image data to a temporary file. Returns the absolute file path. */
export async function savePastedImage(data: number[], mediaType: string): Promise<string> {
  return invoke<string>("save_pasted_image", { data, mediaType });
}

/**
 * Enhances a pipeline task prompt using the local `claude` CLI in print mode.
 * Uses the user's existing Claude Code subscription — no API key required.
 * @param prompt - The raw prompt text to improve
 * @param cwd - Optional working directory for project context
 */
export async function enhancePromptWithClaude(
  prompt: string,
  cwd?: string
): Promise<string> {
  return invoke<string>("enhance_prompt_with_claude", { prompt, cwd: cwd ?? null });
}

/** Writes raw bytes to the PTY stdin of the given session. */
export async function writeStdin(sessionId: number, data: string): Promise<void> {
  return invoke("write_stdin", { sessionId, data });
}

/**
 * Sends a (possibly multi-line) prompt to an interactive Claude Code session and submits it.
 *
 * Rules that are known to work from testing:
 *  - `\r` as a *separate* writeStdin call (with a small delay) submits — matching
 *    how SessionControlRow.sendToSession works.
 *  - Embedding `\n` or `\x1b[13;2u` inside a larger text buffer causes either early
 *    submits or cut-off text because Claude Code processes them mid-stream.
 *
 * Solution: split the prompt on newlines and send each line as its own writeStdin
 * call, followed immediately by an isolated `\x1b[13;2u` (Shift+Enter) write.
 * This mirrors exactly what happens when the user presses Shift+Enter in xterm.js —
 * the escape sequence arrives as a standalone write, never embedded mid-text.
 * After all lines are buffered, a final `\r` (50 ms later) submits the whole prompt.
 */
export async function sendPromptToSession(sessionId: number, text: string): Promise<void> {
  const lines = text.split("\n");
  for (let i = 0; i < lines.length - 1; i++) {
    if (lines[i]) await writeStdin(sessionId, lines[i]);
    // Isolated Shift+Enter: inserts a newline in Claude Code's input buffer without submitting.
    await writeStdin(sessionId, "\x1b[13;2u");
    // 16 ms pause lets readline fully process the Shift+Enter escape sequence before
    // the next line arrives. Without this, rapid back-to-back writes cause the PTY to
    // buffer everything faster than readline can parse escape sequences, silently
    // dropping lines (the symptom: only the last few lines of a long prompt are received).
    await new Promise((r) => setTimeout(r, 16));
  }
  // Last line (may be empty string for trailing newlines — still safe to write)
  await writeStdin(sessionId, lines[lines.length - 1] ?? "");
  await new Promise((r) => setTimeout(r, 100));
  await writeStdin(sessionId, "\r");
}

/** Notifies the backend PTY of a terminal dimension change (rows x cols). */
export async function resizePty(sessionId: number, rows: number, cols: number): Promise<void> {
  return invoke("resize_pty", { sessionId, rows, cols });
}

/** Terminates the backend PTY process and cleans up the session. */
export async function killSession(sessionId: number): Promise<void> {
  return invoke("kill_session", { sessionId });
}

/**
 * Returns buffered PTY output (scrollback history) for a session.
 * Used on TerminalView mount to restore terminal history after a WebView reload.
 * Returns an empty string if the session has no buffered output.
 */
export async function getSessionScrollback(sessionId: number): Promise<string> {
  return invoke<string>("get_session_scrollback", { sessionId });
}

/** AI mode variants matching the backend enum. */
export type AiMode = "Claude" | "Gemini" | "Codex" | "OpenCode" | "Pi" | "Plain";

/** CLI modes that support flags (excludes Plain). */
export type CliAiMode = Exclude<AiMode, "Plain">;

/** CLI command configuration for each AI mode */
export const AI_CLI_CONFIG: Record<AiMode, {
  command: string | null;
  installHint: string;
  skipPermissionsFlag: string | null;
}> = {
  Claude: {
    command: "claude",
    installHint: "npm install -g @anthropic-ai/claude-code",
    skipPermissionsFlag: "--dangerously-skip-permissions",
  },
  Gemini: {
    command: "gemini",
    installHint: "npm install -g @google/gemini-cli",
    skipPermissionsFlag: "--yolo",
  },
  Codex: {
    command: "codex",
    installHint: "npm install -g codex",
    skipPermissionsFlag: "--dangerously-bypass-approvals-and-sandbox",
  },
  OpenCode: {
    command: "opencode",
    installHint: "npm install -g opencode-ai",
    skipPermissionsFlag: "--dangerously-skip-permissions",
  },
  Pi: {
    command: "pi",
    installHint: "Install Pi from https://pi.mariozechner.at",
    skipPermissionsFlag: null,
  },
  Plain: {
    command: null,
    installHint: "",
    skipPermissionsFlag: null,
  },
};

/** Writes hooks configuration for a Claude session to .claude/settings.local.json. */
export async function writeSessionHooksConfig(
  workingDir: string,
  sessionId: number
): Promise<void> {
  await invoke("write_session_hooks_config", {
    workingDir,
    sessionId,
  });
}

/** Removes hooks configuration from .claude/settings.local.json. */
export async function removeSessionHooksConfig(
  workingDir: string
): Promise<void> {
  await invoke("remove_session_hooks_config", { workingDir });
}

/** Checks if a CLI tool is available in the user's PATH */
export async function checkCliAvailable(command: string): Promise<boolean> {
  return invoke<boolean>("check_cli_available", { command });
}

/** Session config returned by createSession. */
export interface SessionConfig {
  id: number;
  mode: AiMode;
  branch: string | null;
  status: string;
  worktree_path: string | null;
  project_path: string;
}

/** Creates a session in the SessionManager (separate from PTY spawning). */
export async function createSession(
  id: number,
  mode: AiMode,
  projectPath: string
): Promise<SessionConfig> {
  return invoke<SessionConfig>("create_session", { id, mode, projectPath });
}

/** Assigns a branch and optional worktree path to a session. */
export async function assignSessionBranch(
  sessionId: number,
  branch: string,
  worktreePath: string | null
): Promise<SessionConfig> {
  return invoke<SessionConfig>("assign_session_branch", { sessionId, branch, worktreePath });
}

/**
 * Subscribes to the per-session `pty-output-{sessionId}` Tauri event.
 * Returns a promise that resolves to an unlisten function. The caller must
 * invoke the unlisten function on cleanup to avoid leaked event listeners.
 */
export function onPtyOutput(
  sessionId: number,
  callback: (data: string) => void,
): Promise<UnlistenFn> {
  return listen<string>(`pty-output-${sessionId}`, (event) => {
    callback(event.payload);
  });
}

/** Backend info as returned by the Rust backend. */
export interface BackendInfo {
  backendType: BackendType;
  capabilities: BackendCapabilities;
}

/** Cached backend info to avoid repeated IPC calls. */
let cachedBackendInfo: BackendInfo | null = null;

/**
 * Returns information about the active terminal backend.
 * The result is cached after the first call.
 */
export async function getBackendInfo(): Promise<BackendInfo> {
  if (cachedBackendInfo) {
    return cachedBackendInfo;
  }
  cachedBackendInfo = await invoke<BackendInfo>("get_backend_info");
  return cachedBackendInfo;
}

/** Checks if the current backend supports enhanced terminal state. */
export async function hasEnhancedState(): Promise<boolean> {
  const info = await getBackendInfo();
  return info.capabilities.enhancedState;
}

// Terminal ready signaling mechanism
// Used to coordinate between TerminalGrid (which sends CLI commands) and
// TerminalView (which needs to be listening for PTY output first)
//
// Uses window-level storage to ensure the same instance is shared across
// all chunks in production builds (module-level Maps can be duplicated).
declare global {
  interface Window {
    __maestroTerminalsReady?: Set<number>;
  }
}

function getTerminalsReadySet(): Set<number> {
  if (!window.__maestroTerminalsReady) {
    window.__maestroTerminalsReady = new Set();
  }
  return window.__maestroTerminalsReady;
}

/**
 * Signals that a terminal is ready to receive PTY output.
 * Called by TerminalView after xterm.js is mounted and listening.
 */
export function signalTerminalReady(sessionId: number): void {
  getTerminalsReadySet().add(sessionId);
}

/**
 * Waits for a terminal to signal it's ready to receive PTY output.
 * Called by TerminalGrid before sending CLI commands.
 * Uses polling to check if the terminal has signaled ready.
 * @param sessionId - The session ID to wait for
 * @param timeoutMs - Maximum time to wait (default 5000ms to account for font loading)
 * @returns Promise that resolves when terminal is ready or rejects on timeout
 */
export function waitForTerminalReady(sessionId: number, timeoutMs = 5000): Promise<void> {
  return new Promise((resolve, reject) => {
    const startTime = Date.now();
    const pollInterval = 50; // Check every 50ms

    const check = () => {
      const readySet = getTerminalsReadySet();
      if (readySet.has(sessionId)) {
        readySet.delete(sessionId);
        resolve();
        return;
      }

      if (Date.now() - startTime >= timeoutMs) {
        reject(new Error(`Terminal ${sessionId} ready timeout after ${timeoutMs}ms`));
        return;
      }

      setTimeout(check, pollInterval);
    };

    check();
  });
}

/**
 * CLI flags for a specific AI mode.
 */
export type CliFlags = {
  skipPermissions: boolean;
  customFlags: string;
  /** Absolute path to mintlet.ts extension (Pi mode only). */
  mintletPath?: string;
};

/**
 * Builds the full CLI command with user-configured flags.
 *
 * @param mode - The AI mode to build the command for
 * @param flags - The CLI flags configuration for this mode
 * @returns The full CLI command string, or null for Plain mode
 *
 * @example
 * buildCliCommand("Claude", { skipPermissions: true, customFlags: "--verbose" })
 * // Returns: "claude --dangerously-skip-permissions --verbose"
 *
 * buildCliCommand("Gemini", { skipPermissions: true, customFlags: "" })
 * // Returns: "gemini --yolo"
 *
 * buildCliCommand("Codex", { skipPermissions: true, customFlags: "" })
 * // Returns: "codex --dangerously-bypass-approvals-and-sandbox"
 */
export function buildCliCommand(mode: AiMode, flags?: CliFlags): string | null {
  const config = AI_CLI_CONFIG[mode];
  if (!config.command) return null;

  const parts: string[] = [config.command];

  if (flags) {
    if (flags.skipPermissions && config.skipPermissionsFlag) {
      parts.push(config.skipPermissionsFlag);
    }
    if (mode === "Pi") {
      // No --provider flag: Pi uses whatever the user configured via /login.
      // Forcing claude-cli here breaks Pi's custom tool loop (run_pipeline etc.)
      // because that provider delegates everything to `claude --print`, which
      // knows nothing about Pi-registered tools.
      if (flags.mintletPath?.trim()) {
        parts.push("-e", flags.mintletPath.trim());
      }
    }
    if (flags.customFlags.trim()) {
      parts.push(flags.customFlags.trim());
    }
  }

  return parts.join(" ");
}
