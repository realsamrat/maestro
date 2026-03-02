import { Loader2, Send, X } from "lucide-react";
import { useState } from "react";
import { killSession, writeStdin } from "@/lib/terminal";
import type { SessionConfig } from "@/stores/useSessionStore";
import type { PipelineStage } from "@/stores/usePipelineStore";

interface SessionControlRowProps {
  session: SessionConfig;
  currentStage?: PipelineStage;
}

/** Send text to Claude Code's TUI and submit it as a separate Enter keypress. */
async function sendToSession(sessionId: number, text: string): Promise<void> {
  await writeStdin(sessionId, text);
  await new Promise((r) => setTimeout(r, 50));
  await writeStdin(sessionId, "\r");
}

function StatusDot({ status }: { status: SessionConfig["status"] }) {
  const colors: Record<SessionConfig["status"], string> = {
    Working: "bg-yellow-400",
    Done: "bg-green-400",
    NeedsInput: "bg-orange-400",
    Error: "bg-red-400",
    Timeout: "bg-red-400",
    Starting: "bg-blue-400",
    Idle: "bg-maestro-muted",
  };
  return (
    <span
      className={`inline-block h-2 w-2 shrink-0 rounded-full ${colors[status] ?? "bg-maestro-muted"}`}
    />
  );
}

export function SessionControlRow({ session, currentStage }: SessionControlRowProps) {
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [killing, setKilling] = useState(false);

  const handleSend = async () => {
    const text = input.trim();
    if (!text || sending) return;
    setSending(true);
    try {
      await sendToSession(session.id, text);
      setInput("");
    } catch (err) {
      console.error(`[Orchestrator] Failed to send to session ${session.id}:`, err);
    } finally {
      setSending(false);
    }
  };

  const handleKillPty = async () => {
    if (killing) return;
    setKilling(true);
    try {
      await killSession(session.id);
    } catch (err) {
      console.error(`[Orchestrator] Failed to kill session ${session.id}:`, err);
    } finally {
      setKilling(false);
    }
  };

  const handlePlan = () => sendToSession(session.id, "/plan");

  // Sends a bare Enter — accepts a pending Claude Code permission prompt
  const handleAccept = () => writeStdin(session.id, "\r");

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") handleSend();
  };

  const sessionLabel = session.branch
    ? `Session ${session.id} · ${session.branch}`
    : `Session ${session.id}`;

  return (
    <div className="flex flex-col gap-1.5 rounded-lg border border-maestro-border bg-maestro-surface p-3">
      {/* Header row */}
      <div className="flex items-center gap-2">
        <StatusDot status={session.status} />
        <span className="text-xs font-medium text-maestro-text truncate flex-1">
          {sessionLabel}
        </span>
        <span className="text-[10px] text-maestro-muted shrink-0">{session.status}</span>

        {/* Kill button */}
        <button
          type="button"
          onClick={handleKillPty}
          disabled={killing}
          title="Kill PTY — then Cmd+W to close pane"
          className="rounded p-0.5 text-maestro-muted transition-colors hover:text-red-400 disabled:opacity-40"
        >
          {killing ? <Loader2 size={11} className="animate-spin" /> : <X size={11} />}
        </button>
      </div>

      {/* Current stage name */}
      {currentStage && (
        <div className="text-[10px] text-maestro-muted truncate pl-4">
          {currentStage.status === "running" && "▶ "}
          {currentStage.status === "pending" && "⏸ "}
          {currentStage.status === "done" && "✓ "}
          {currentStage.name}
        </div>
      )}

      {/* Command input */}
      <div className="flex gap-1.5">
        <input
          type="text"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={`Send to session ${session.id}…`}
          className="flex-1 min-w-0 rounded bg-maestro-bg border border-maestro-border px-2 py-1 text-xs text-maestro-text placeholder:text-maestro-muted/50 focus:border-maestro-accent/60 focus:outline-none"
        />
        <button
          type="button"
          onClick={handleSend}
          disabled={!input.trim() || sending}
          className="flex items-center gap-1 rounded bg-maestro-accent/10 border border-maestro-accent/30 px-2 py-1 text-xs text-maestro-accent transition-colors hover:bg-maestro-accent/20 disabled:opacity-40 disabled:cursor-not-allowed"
        >
          {sending ? <Loader2 size={11} className="animate-spin" /> : <Send size={11} />}
        </button>
      </div>

      {/* Quick-action chips */}
      <div className="flex gap-1.5 pl-0">
        <button
          type="button"
          onClick={handlePlan}
          title="Send /plan to put Claude into plan mode"
          className="rounded border border-maestro-border px-2 py-0.5 text-[10px] text-maestro-muted transition-colors hover:border-maestro-accent/40 hover:text-maestro-accent"
        >
          /plan
        </button>
        <button
          type="button"
          onClick={handleAccept}
          title="Send Enter to accept a pending permission prompt"
          className="rounded border border-maestro-border px-2 py-0.5 text-[10px] text-maestro-muted transition-colors hover:border-green-400/40 hover:text-green-400"
        >
          ↵ accept
        </button>
      </div>
    </div>
  );
}
