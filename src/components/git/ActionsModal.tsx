import {
  AlertCircle,
  Check,
  ChevronDown,
  UploadCloud,
  Download,
  FileText,
  GitBranch,
  GitCommit,
  GitMerge,
  GitPullRequest,
  Loader2,
  Plus,
  RefreshCw,
  X,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useGitStore } from "@/stores/useGitStore";

interface ActionsModalProps {
  repoPath: string;
  currentBranch: string;
  onClose: () => void;
}

type ChangeType = "added" | "modified" | "deleted" | "renamed" | "copied" | "untracked" | "unknown";

interface StatusEntry {
  path: string;
  staged: boolean;
  change: ChangeType;
}

interface PrInfo {
  number: number;
  title: string;
  url: string;
  state: string;
}

type Tab = "commit" | "sync" | "pr";

const CHANGE_COLORS: Record<ChangeType, string> = {
  added: "text-maestro-green",
  modified: "text-maestro-accent",
  deleted: "text-maestro-red",
  renamed: "text-yellow-400",
  copied: "text-maestro-accent",
  untracked: "text-maestro-muted",
  unknown: "text-maestro-muted",
};

const CHANGE_LABELS: Record<ChangeType, string> = {
  added: "A",
  modified: "M",
  deleted: "D",
  renamed: "R",
  copied: "C",
  untracked: "?",
  unknown: "?",
};

export function ActionsModal({ repoPath, currentBranch, onClose }: ActionsModalProps) {
  const modalRef = useRef<HTMLDivElement>(null);
  const [activeTab, setActiveTab] = useState<Tab>("commit");

  // Close on outside click
  useEffect(() => {
    const handleClick = (e: MouseEvent) => {
      if (modalRef.current && !modalRef.current.contains(e.target as Node)) {
        onClose();
      }
    };
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [onClose]);

  // Close on Escape
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [onClose]);

  const tabs: { id: Tab; label: string; icon: React.ReactNode }[] = [
    { id: "commit", label: "Commit", icon: <GitCommit size={13} /> },
    { id: "sync", label: "Sync", icon: <RefreshCw size={13} /> },
    { id: "pr", label: "Pull Request", icon: <GitPullRequest size={13} /> },
  ];

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm">
      <div
        ref={modalRef}
        className="w-full max-w-lg rounded-lg border border-maestro-border bg-maestro-bg shadow-2xl"
      >
        {/* Header */}
        <div className="flex items-center justify-between border-b border-maestro-border px-4 py-3">
          <div className="flex items-center gap-2">
            <GitMerge size={15} className="text-maestro-accent" />
            <h2 className="text-sm font-semibold text-maestro-text">Git Actions</h2>
            <span className="flex items-center gap-1 rounded bg-maestro-card px-1.5 py-0.5 text-[11px] text-maestro-muted">
              <GitBranch size={10} />
              {currentBranch}
            </span>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded p-1 hover:bg-maestro-border/40"
          >
            <X size={16} className="text-maestro-muted" />
          </button>
        </div>

        {/* Tab bar */}
        <div className="flex border-b border-maestro-border">
          {tabs.map((tab) => (
            <button
              key={tab.id}
              type="button"
              onClick={() => setActiveTab(tab.id)}
              className={`flex flex-1 items-center justify-center gap-1.5 px-4 py-2.5 text-xs font-medium transition-colors ${
                activeTab === tab.id
                  ? "border-b-2 border-maestro-accent text-maestro-accent"
                  : "text-maestro-muted hover:text-maestro-text"
              }`}
            >
              {tab.icon}
              {tab.label}
            </button>
          ))}
        </div>

        {/* Tab content */}
        <div className="max-h-[60vh] overflow-y-auto p-4">
          {activeTab === "commit" && (
            <CommitTab repoPath={repoPath} currentBranch={currentBranch} />
          )}
          {activeTab === "sync" && (
            <SyncTab repoPath={repoPath} currentBranch={currentBranch} />
          )}
          {activeTab === "pr" && (
            <PrTab repoPath={repoPath} currentBranch={currentBranch} />
          )}
        </div>
      </div>
    </div>
  );
}

/* ── Commit Tab ── */

function CommitTab({ repoPath, currentBranch }: { repoPath: string; currentBranch: string }) {
  const [status, setStatus] = useState<StatusEntry[]>([]);
  const [loadingStatus, setLoadingStatus] = useState(true);
  const [message, setMessage] = useState("");
  const [committing, setCommitting] = useState(false);
  const [staging, setStaging] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);

  const fetchStatus = useCallback(async () => {
    setLoadingStatus(true);
    try {
      const entries = await invoke<StatusEntry[]>("git_status", { repoPath });
      setStatus(entries);
    } catch (err) {
      console.error("Failed to get status:", err);
    } finally {
      setLoadingStatus(false);
    }
  }, [repoPath]);

  useEffect(() => {
    fetchStatus();
  }, [fetchStatus]);

  const stagedFiles = status.filter((e) => e.staged);
  const unstagedFiles = status.filter((e) => !e.staged);
  const hasChanges = status.length > 0;
  const hasStaged = stagedFiles.length > 0;

  const handleStageAll = async () => {
    setStaging(true);
    try {
      await invoke("git_stage_all", { repoPath });
      await fetchStatus();
    } catch (err) {
      setResult({ ok: false, text: String(err) });
    } finally {
      setStaging(false);
    }
  };

  const handleCommit = async () => {
    if (!message.trim() || !hasStaged) return;
    setCommitting(true);
    setResult(null);
    try {
      const hash = await invoke<string>("git_commit", { repoPath, message: message.trim() });
      setResult({ ok: true, text: `Committed ${hash}` });
      setMessage("");
      await fetchStatus();
    } catch (err) {
      setResult({ ok: false, text: String(err) });
    } finally {
      setCommitting(false);
    }
  };

  if (loadingStatus) {
    return (
      <div className="flex items-center justify-center py-8">
        <Loader2 size={18} className="animate-spin text-maestro-muted" />
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {/* Branch info */}
      <div className="flex items-center justify-between">
        <span className="text-xs text-maestro-muted">
          Changes on <span className="text-maestro-text font-medium">{currentBranch}</span>
        </span>
        <button
          type="button"
          onClick={fetchStatus}
          className="rounded p-1 hover:bg-maestro-border/40"
          title="Refresh"
        >
          <RefreshCw size={12} className="text-maestro-muted" />
        </button>
      </div>

      {!hasChanges ? (
        <div className="flex items-center gap-2 rounded-lg border border-maestro-border bg-maestro-card p-3">
          <Check size={14} className="text-maestro-green" />
          <span className="text-xs text-maestro-muted">Working tree clean — nothing to commit</span>
        </div>
      ) : (
        <>
          {/* Staged files */}
          {stagedFiles.length > 0 && (
            <div className="rounded-lg border border-maestro-border bg-maestro-card overflow-hidden">
              <div className="flex items-center justify-between px-3 py-2 border-b border-maestro-border/50">
                <span className="text-[11px] font-semibold uppercase tracking-wide text-maestro-muted">
                  Staged ({stagedFiles.length})
                </span>
              </div>
              <div className="max-h-32 overflow-y-auto">
                {stagedFiles.map((f, i) => (
                  <FileRow key={i} entry={f} />
                ))}
              </div>
            </div>
          )}

          {/* Unstaged / untracked files */}
          {unstagedFiles.length > 0 && (
            <div className="rounded-lg border border-maestro-border bg-maestro-card overflow-hidden">
              <div className="flex items-center justify-between px-3 py-2 border-b border-maestro-border/50">
                <span className="text-[11px] font-semibold uppercase tracking-wide text-maestro-muted">
                  Unstaged ({unstagedFiles.length})
                </span>
                <button
                  type="button"
                  onClick={handleStageAll}
                  disabled={staging}
                  className="flex items-center gap-1 text-[11px] text-maestro-accent hover:underline disabled:opacity-50"
                >
                  {staging ? <Loader2 size={10} className="animate-spin" /> : <Plus size={10} />}
                  Stage all
                </button>
              </div>
              <div className="max-h-32 overflow-y-auto">
                {unstagedFiles.map((f, i) => (
                  <FileRow key={i} entry={f} />
                ))}
              </div>
            </div>
          )}
        </>
      )}

      {/* Commit form */}
      <div className="space-y-2">
        <textarea
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          placeholder="Commit message…"
          rows={3}
          className="w-full resize-none rounded border border-maestro-border bg-maestro-card px-3 py-2 text-xs text-maestro-text placeholder:text-maestro-muted focus:outline-none focus:border-maestro-accent"
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) handleCommit();
          }}
        />
        <button
          type="button"
          onClick={handleCommit}
          disabled={!message.trim() || !hasStaged || committing}
          className="flex w-full items-center justify-center gap-2 rounded bg-maestro-accent px-3 py-2 text-xs font-medium text-white hover:bg-maestro-accent/90 disabled:opacity-40 disabled:cursor-not-allowed"
        >
          {committing ? <Loader2 size={13} className="animate-spin" /> : <GitCommit size={13} />}
          Commit
          <span className="text-[10px] opacity-70">⌘↵</span>
        </button>
      </div>

      {result && (
        <div className={`flex items-start gap-2 rounded p-2 text-xs ${result.ok ? "bg-maestro-green/10 text-maestro-green" : "bg-maestro-red/10 text-maestro-red"}`}>
          {result.ok ? <Check size={13} className="mt-px shrink-0" /> : <AlertCircle size={13} className="mt-px shrink-0" />}
          <span className="break-all">{result.text}</span>
        </div>
      )}
    </div>
  );
}

function FileRow({ entry }: { entry: StatusEntry }) {
  const label = CHANGE_LABELS[entry.change] ?? "?";
  const color = CHANGE_COLORS[entry.change] ?? "text-maestro-muted";
  const parts = entry.path.split("/");
  const filename = parts[parts.length - 1];
  const dir = parts.length > 1 ? parts.slice(0, -1).join("/") + "/" : "";

  return (
    <div className="flex items-center gap-2 px-3 py-1.5 hover:bg-maestro-surface/50">
      <span className={`w-4 text-center text-[11px] font-bold shrink-0 ${color}`}>{label}</span>
      <div className="min-w-0 flex-1">
        <span className="text-[11px] text-maestro-muted">{dir}</span>
        <span className="text-[11px] text-maestro-text">{filename}</span>
      </div>
    </div>
  );
}

/* ── Sync Tab ── */

function SyncTab({ repoPath, currentBranch }: { repoPath: string; currentBranch: string }) {
  const { remotes, fetchRemotes } = useGitStore();
  const [pushing, setPushing] = useState(false);
  const [pulling, setPulling] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);
  const [selectedRemote, setSelectedRemote] = useState("origin");
  const [remoteDropdownOpen, setRemoteDropdownOpen] = useState(false);

  useEffect(() => {
    fetchRemotes(repoPath);
  }, [repoPath, fetchRemotes]);

  useEffect(() => {
    if (remotes.length > 0 && !remotes.find((r) => r.name === selectedRemote)) {
      setSelectedRemote(remotes[0].name);
    }
  }, [remotes, selectedRemote]);

  const handlePush = async () => {
    setPushing(true);
    setResult(null);
    try {
      await invoke("git_push", { repoPath, remote: selectedRemote, branch: currentBranch });
      setResult({ ok: true, text: `Pushed ${currentBranch} → ${selectedRemote}` });
    } catch (err) {
      setResult({ ok: false, text: String(err) });
    } finally {
      setPushing(false);
    }
  };

  const handlePull = async () => {
    setPulling(true);
    setResult(null);
    try {
      await invoke("git_pull", { repoPath, remote: selectedRemote, branch: currentBranch });
      setResult({ ok: true, text: `Pulled from ${selectedRemote}/${currentBranch}` });
    } catch (err) {
      setResult({ ok: false, text: String(err) });
    } finally {
      setPulling(false);
    }
  };

  return (
    <div className="space-y-3">
      {/* Remote selector */}
      {remotes.length > 0 && (
        <div className="relative">
          <label className="mb-1 block text-[11px] font-medium uppercase tracking-wide text-maestro-muted">
            Remote
          </label>
          <button
            type="button"
            onClick={() => setRemoteDropdownOpen((p) => !p)}
            className="flex w-full items-center justify-between rounded border border-maestro-border bg-maestro-card px-3 py-2 text-xs text-maestro-text hover:border-maestro-accent/50"
          >
            <span>{selectedRemote}</span>
            <ChevronDown size={12} className="text-maestro-muted" />
          </button>
          {remoteDropdownOpen && (
            <div className="absolute z-10 mt-1 w-full rounded border border-maestro-border bg-maestro-bg shadow-lg">
              {remotes.map((r) => (
                <button
                  key={r.name}
                  type="button"
                  onClick={() => { setSelectedRemote(r.name); setRemoteDropdownOpen(false); }}
                  className="flex w-full items-center gap-2 px-3 py-2 text-xs text-maestro-text hover:bg-maestro-card"
                >
                  {r.name === selectedRemote && <Check size={11} className="text-maestro-accent" />}
                  <span className={r.name === selectedRemote ? "ml-0" : "ml-4"}>{r.name}</span>
                  <span className="ml-auto truncate text-[10px] text-maestro-muted">{r.url}</span>
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Branch info */}
      <div className="rounded-lg border border-maestro-border bg-maestro-card p-3">
        <div className="flex items-center gap-2 text-xs">
          <GitBranch size={13} className="text-maestro-accent shrink-0" />
          <span className="text-maestro-muted">Branch:</span>
          <span className="font-medium text-maestro-text">{currentBranch}</span>
          <span className="text-maestro-muted">→</span>
          <span className="text-maestro-muted">{selectedRemote}/{currentBranch}</span>
        </div>
      </div>

      {/* Push / Pull buttons */}
      <div className="grid grid-cols-2 gap-2">
        <button
          type="button"
          onClick={handlePull}
          disabled={pulling || pushing}
          className="flex items-center justify-center gap-2 rounded border border-maestro-border bg-maestro-card px-3 py-2.5 text-xs font-medium text-maestro-text hover:border-maestro-accent/50 hover:text-maestro-accent disabled:opacity-40 disabled:cursor-not-allowed"
        >
          {pulling ? <Loader2 size={13} className="animate-spin" /> : <Download size={13} />}
          Pull
        </button>
        <button
          type="button"
          onClick={handlePush}
          disabled={pushing || pulling}
          className="flex items-center justify-center gap-2 rounded bg-maestro-accent px-3 py-2.5 text-xs font-medium text-white hover:bg-maestro-accent/90 disabled:opacity-40 disabled:cursor-not-allowed"
        >
          {pushing ? <Loader2 size={13} className="animate-spin" /> : <UploadCloud size={13} />}
          Push
        </button>
      </div>

      {result && (
        <div className={`flex items-start gap-2 rounded p-2 text-xs ${result.ok ? "bg-maestro-green/10 text-maestro-green" : "bg-maestro-red/10 text-maestro-red"}`}>
          {result.ok ? <Check size={13} className="mt-px shrink-0" /> : <AlertCircle size={13} className="mt-px shrink-0" />}
          <span className="break-all">{result.text}</span>
        </div>
      )}
    </div>
  );
}

/* ── Pull Request Tab ── */

function PrTab({ repoPath, currentBranch }: { repoPath: string; currentBranch: string }) {
  const [prs, setPrs] = useState<PrInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [showCreateForm, setShowCreateForm] = useState(false);
  const [prTitle, setPrTitle] = useState("");
  const [prBody, setPrBody] = useState("");
  const [createResult, setCreateResult] = useState<{ ok: boolean; text: string } | null>(null);

  const fetchPrs = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await invoke<PrInfo[]>("github_list_prs", {
        repoPath,
        state: "open",
      });
      setPrs(result);
    } catch (err) {
      const msg = String(err);
      // Not authenticated or no remote — show helpful message
      if (msg.includes("authentication") || msg.includes("not found") || msg.includes("gh")) {
        setError("GitHub CLI (gh) not authenticated. Run `gh auth login` in a terminal.");
      } else {
        setError(msg);
      }
    } finally {
      setLoading(false);
    }
  }, [repoPath]);

  useEffect(() => {
    fetchPrs();
  }, [fetchPrs]);

  const handleCreatePr = async () => {
    if (!prTitle.trim()) return;
    setCreating(true);
    setCreateResult(null);
    try {
      await invoke("github_create_pr", {
        repoPath,
        title: prTitle.trim(),
        body: prBody.trim() || null,
        head: currentBranch,
        base: null,
        draft: false,
      });
      setCreateResult({ ok: true, text: "Pull request created!" });
      setPrTitle("");
      setPrBody("");
      setShowCreateForm(false);
      await fetchPrs();
    } catch (err) {
      setCreateResult({ ok: false, text: String(err) });
    } finally {
      setCreating(false);
    }
  };

  const currentBranchPr = prs.find((pr) => pr.title !== undefined);

  if (loading) {
    return (
      <div className="flex items-center justify-center py-8">
        <Loader2 size={18} className="animate-spin text-maestro-muted" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="space-y-3">
        <div className="flex items-start gap-2 rounded-lg border border-maestro-border bg-maestro-card p-3 text-xs text-maestro-muted">
          <AlertCircle size={14} className="mt-px shrink-0 text-maestro-red" />
          <span>{error}</span>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {/* Header row */}
      <div className="flex items-center justify-between">
        <span className="text-xs text-maestro-muted">
          {prs.length} open pull request{prs.length !== 1 ? "s" : ""}
        </span>
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={fetchPrs}
            className="rounded p-1 hover:bg-maestro-border/40"
            title="Refresh"
          >
            <RefreshCw size={12} className="text-maestro-muted" />
          </button>
          <button
            type="button"
            onClick={() => setShowCreateForm((p) => !p)}
            className="flex items-center gap-1 rounded border border-maestro-border bg-maestro-card px-2 py-1 text-xs text-maestro-text hover:border-maestro-accent/50"
          >
            <Plus size={12} />
            New PR
          </button>
        </div>
      </div>

      {/* Create PR form */}
      {showCreateForm && (
        <div className="rounded-lg border border-maestro-accent/30 bg-maestro-card p-3 space-y-2">
          <p className="text-[11px] text-maestro-muted">
            Creating PR from <span className="text-maestro-text font-medium">{currentBranch}</span>
          </p>
          <input
            type="text"
            value={prTitle}
            onChange={(e) => setPrTitle(e.target.value)}
            placeholder="PR title"
            className="w-full rounded border border-maestro-border bg-maestro-bg px-2 py-1.5 text-xs text-maestro-text placeholder:text-maestro-muted focus:outline-none focus:border-maestro-accent"
            autoFocus
          />
          <textarea
            value={prBody}
            onChange={(e) => setPrBody(e.target.value)}
            placeholder="Description (optional)"
            rows={3}
            className="w-full resize-none rounded border border-maestro-border bg-maestro-bg px-2 py-1.5 text-xs text-maestro-text placeholder:text-maestro-muted focus:outline-none focus:border-maestro-accent"
          />
          <div className="flex justify-end gap-1">
            <button
              type="button"
              onClick={() => { setShowCreateForm(false); setCreateResult(null); }}
              className="rounded px-2 py-1 text-xs text-maestro-muted hover:bg-maestro-border/40"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={handleCreatePr}
              disabled={!prTitle.trim() || creating}
              className="flex items-center gap-1 rounded bg-maestro-accent px-3 py-1 text-xs font-medium text-white disabled:opacity-40"
            >
              {creating ? <Loader2 size={11} className="animate-spin" /> : <GitPullRequest size={11} />}
              Create PR
            </button>
          </div>
          {createResult && (
            <div className={`flex items-start gap-2 rounded p-2 text-xs ${createResult.ok ? "bg-maestro-green/10 text-maestro-green" : "bg-maestro-red/10 text-maestro-red"}`}>
              {createResult.ok ? <Check size={12} className="mt-px shrink-0" /> : <AlertCircle size={12} className="mt-px shrink-0" />}
              <span>{createResult.text}</span>
            </div>
          )}
        </div>
      )}

      {/* PR list */}
      {prs.length === 0 && !showCreateForm ? (
        <div className="flex flex-col items-center gap-3 py-6 text-center">
          <GitPullRequest size={24} className="text-maestro-muted" />
          <p className="text-xs text-maestro-muted">No open pull requests</p>
          <button
            type="button"
            onClick={() => setShowCreateForm(true)}
            className="flex items-center gap-1 rounded bg-maestro-accent px-3 py-1.5 text-xs font-medium text-white"
          >
            <Plus size={12} />
            Create Pull Request
          </button>
        </div>
      ) : (
        <div className="space-y-2">
          {prs.map((pr) => (
            <PrRow key={pr.number} pr={pr} currentBranch={currentBranch} />
          ))}
        </div>
      )}

      {currentBranchPr === undefined && prs.length > 0 && (
        <p className="text-[11px] text-maestro-muted text-center pt-1">
          No open PR for <span className="text-maestro-text">{currentBranch}</span>
        </p>
      )}
    </div>
  );
}

function PrRow({ pr, currentBranch: _ }: { pr: PrInfo; currentBranch: string }) {
  return (
    <div className="flex items-start gap-3 rounded-lg border border-maestro-border bg-maestro-card p-3 hover:border-maestro-accent/30 transition-colors">
      <GitPullRequest size={14} className="mt-px shrink-0 text-maestro-green" />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="text-xs font-medium text-maestro-text truncate">{pr.title}</span>
          <span className="shrink-0 text-[10px] text-maestro-muted">#{pr.number}</span>
        </div>
        {pr.url && (
          <a
            href={pr.url}
            target="_blank"
            rel="noreferrer"
            className="flex items-center gap-1 mt-0.5 text-[11px] text-maestro-accent hover:underline"
            onClick={(e) => e.stopPropagation()}
          >
            <FileText size={10} />
            View on GitHub
          </a>
        )}
      </div>
    </div>
  );
}
