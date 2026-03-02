import {
  AlertTriangle,
  ArrowDown,
  ArrowUp,
  ChevronDown,
  FlaskConical,
  GitBranch,
  ImagePlus,
  Layers,
  ListChecks,
  Loader2,
  Network,
  Pencil,
  Play,
  Plus,
  RotateCcw,
  SkipForward,
  Sparkles,
  Trash2,
  X,
  Zap,
} from "lucide-react";
import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  generateBranchName,
  usePipelineStore,
  type HumanApprovalRequest,
  type PipelineStage,
  type PipelineTemplate,
  type RoutingRule,
  type SessionLifecycle,
  type StageType,
} from "@/stores/usePipelineStore";
import { useSessionStore } from "@/stores/useSessionStore";
import { enhancePromptWithClaude, savePastedImage, sendPromptToSession } from "@/lib/terminal";
import { SessionControlRow } from "./SessionControlRow";

// ─── Stage type icons + colors ────────────────────────────────────────────────

function stageTypeIcon(type: StageType, size = 10) {
  if (type === "review") return <ListChecks size={size} />;
  if (type === "tester") return <FlaskConical size={size} />;
  if (type === "pr") return <GitBranch size={size} />;
  return <Zap size={size} />;
}

const STAGE_TYPE_COLORS: Record<StageType, { card: string; badge: string; accent: string }> = {
  task: {
    card: "border-maestro-border",
    badge: "bg-blue-400/15 text-blue-400 border border-blue-400/30",
    accent: "text-blue-400",
  },
  review: {
    card: "border-purple-400/30",
    badge: "bg-purple-400/15 text-purple-400 border border-purple-400/30",
    accent: "text-purple-400",
  },
  tester: {
    card: "border-orange-400/30",
    badge: "bg-orange-400/15 text-orange-400 border border-orange-400/30",
    accent: "text-orange-400",
  },
  pr: {
    card: "border-green-400/30",
    badge: "bg-green-400/15 text-green-400 border border-green-400/30",
    accent: "text-green-400",
  },
};

// ─── Stage status badge ───────────────────────────────────────────────────────

function StageBadge({ status }: { status: PipelineStage["status"] }) {
  const map: Record<PipelineStage["status"], { label: string; cls: string }> = {
    pending: { label: "Pending", cls: "bg-maestro-muted/20 text-maestro-muted" },
    running: { label: "Running", cls: "bg-yellow-400/20 text-yellow-400" },
    done: { label: "Done", cls: "bg-green-400/20 text-green-400" },
    skipped: { label: "Skipped", cls: "bg-maestro-muted/10 text-maestro-muted/60" },
  };
  const { label, cls } = map[status];
  return (
    <span className={`rounded px-1.5 py-0.5 text-[10px] font-medium ${cls}`}>{label}</span>
  );
}

// ─── Routing rule editor ──────────────────────────────────────────────────────

interface RoutingRuleEditorProps {
  rules: RoutingRule[];
  stages: PipelineStage[];
  currentStageId?: string;
  onChange: (rules: RoutingRule[]) => void;
  stageType: StageType;
}

function RoutingRuleEditor({
  rules,
  stages,
  currentStageId,
  onChange,
  stageType,
}: RoutingRuleEditorProps) {
  const otherStages = stages.filter((s) => s.id !== currentStageId);

  const getRule = (condition: RoutingRule["condition"]) =>
    rules.find((r) => r.condition === condition);

  const setRule = (condition: RoutingRule["condition"], targetStageId: string) => {
    if (!targetStageId) {
      onChange(rules.filter((r) => r.condition !== condition));
      return;
    }
    const existing = rules.find((r) => r.condition === condition);
    if (existing) {
      onChange(rules.map((r) => (r.condition === condition ? { ...r, targetStageId } : r)));
    } else {
      onChange([...rules, { condition, keywords: [], targetStageId }]);
    }
  };

  return (
    <div className="flex flex-col gap-1.5">
      <label className="text-[10px] text-maestro-muted">Routing rules (optional)</label>
      <div className="grid grid-cols-2 gap-1.5">
        <div className="flex flex-col gap-0.5">
          <span className="text-[9px] text-green-400">On approved →</span>
          <select
            value={getRule("approved")?.targetStageId ?? ""}
            onChange={(e) => setRule("approved", e.target.value)}
            className="rounded border border-maestro-border bg-maestro-bg px-1.5 py-0.5 text-[10px] text-maestro-text focus:border-green-400/60 focus:outline-none"
          >
            <option value="">— none —</option>
            {otherStages.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        </div>
        <div className="flex flex-col gap-0.5">
          <span className="text-[9px] text-red-400">On changes →</span>
          <select
            value={getRule("changes_needed")?.targetStageId ?? ""}
            onChange={(e) => setRule("changes_needed", e.target.value)}
            className="rounded border border-maestro-border bg-maestro-bg px-1.5 py-0.5 text-[10px] text-maestro-text focus:border-red-400/60 focus:outline-none"
          >
            <option value="">— none —</option>
            {(stageType === "review" || stageType === "tester") && (
              <option value="__source__">← back to source</option>
            )}
            {otherStages.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        </div>
      </div>
    </div>
  );
}

// ─── Stage form (add or edit) ─────────────────────────────────────────────────

interface StageFormProps {
  editStage?: PipelineStage;
  onDone: () => void;
}

function StageForm({ editStage, onDone }: StageFormProps) {
  const sessions = useSessionStore((s) => s.sessions);
  const stages = usePipelineStore((s) => s.stages);
  const addStage = usePipelineStore((s) => s.addStage);
  const updateStage = usePipelineStore((s) => s.updateStage);

  const isEditing = !!editStage;

  const [stageType, setStageType] = useState<StageType>(editStage?.type ?? "task");
  const [name, setName] = useState(editStage?.name ?? "");
  const [sessionId, setSessionId] = useState<number | "">(() => {
    // If the stage's saved session is still alive, keep it; otherwise fall back to
    // the first live session so the select state matches what the user sees.
    const saved = editStage?.sessionId;
    if (saved !== undefined && sessions.some((s) => s.id === saved)) return saved;
    return sessions[0]?.id ?? "";
  });
  const [taskPrompt, setTaskPrompt] = useState(editStage?.taskPrompt ?? "");
  const [depIds, setDepIds] = useState<string[]>(editStage?.dependsOn ?? []);
  const [feedsFromIds, setFeedsFromIds] = useState<string[]>(editStage?.feedsFromStages ?? []);
  const [autoSend, setAutoSend] = useState(editStage?.autoSend ?? true);
  const [useRufloMemory, setUseRufloMemory] = useState(editStage?.useRufloMemory ?? false);
  const [lifecycle, setLifecycle] = useState<SessionLifecycle>(editStage?.sessionLifecycle ?? "fresh-on-rework");
  const [routingRules, setRoutingRules] = useState<RoutingRule[]>(editStage?.routingRules ?? []);
  const [autoBranch, setAutoBranch] = useState(editStage?.autoBranch ?? true);
  const [autoBranchPrefix, setAutoBranchPrefix] = useState(editStage?.autoBranchPrefix ?? "feature/");
  const [attachedImages, setAttachedImages] = useState<{ path: string; previewUrl?: string }[]>(
    (editStage?.attachedImages ?? []).map((img) => ({ path: img.path }))
  );

  // Feature A: AI prompt enhancement
  const [isEnhancing, setIsEnhancing] = useState(false);
  const [enhanceError, setEnhanceError] = useState<string | null>(null);

  // Exclude current stage from selectors when editing to avoid self-reference
  const availableStages = isEditing ? stages.filter((s) => s.id !== editStage?.id) : stages;

  const handleEnhance = async () => {
    if (!taskPrompt.trim() || isEnhancing) return;
    setIsEnhancing(true);
    setEnhanceError(null);
    try {
      const enhanced = await enhancePromptWithClaude(taskPrompt.trim());
      setTaskPrompt(enhanced);
    } catch (err) {
      setEnhanceError(String(err));
    } finally {
      setIsEnhancing(false);
    }
  };

  const handlePaste = async (e: React.ClipboardEvent) => {
    const items = Array.from(e.clipboardData.items);
    const imageItem = items.find((i) => i.type.startsWith("image/"));
    if (!imageItem) return;
    e.preventDefault();
    const blob = imageItem.getAsFile();
    if (!blob) return;
    try {
      const bytes = Array.from(new Uint8Array(await blob.arrayBuffer()));
      const path = await savePastedImage(bytes, imageItem.type);
      const previewUrl = URL.createObjectURL(blob);
      setAttachedImages((prev) => [...prev, { path, previewUrl }]);
    } catch (err) {
      console.error("[Pipeline] Failed to save pasted image:", err);
    }
  };

  // Update lifecycle default when stage type changes
  const handleTypeChange = (type: StageType) => {
    setStageType(type);
    if (type === "review" || type === "tester") setLifecycle("always-fresh");
    else if (type === "pr") setLifecycle("persistent");
    else setLifecycle("fresh-on-rework");
  };

  const handleSubmit = () => {
    if (!name.trim() || sessionId === "" || !taskPrompt.trim()) return;
    const stageData = {
      type: stageType,
      sessionId: sessionId as number,
      name: name.trim(),
      taskPrompt: taskPrompt.trim(),
      dependsOn: depIds,
      feedsFromStages: feedsFromIds,
      autoSend,
      useRufloMemory,
      sessionLifecycle: lifecycle,
      routingRules,
      reviewQueue: [],
      autoBranch,
      autoBranchPrefix,
      attachedImages: attachedImages.map(({ path }) => ({ path })),
    };
    if (isEditing && editStage) {
      updateStage(editStage.id, stageData);
    } else {
      addStage(stageData);
    }
    onDone();
  };

  const toggleDep = (id: string) => {
    setDepIds((prev) => (prev.includes(id) ? prev.filter((d) => d !== id) : [...prev, id]));
  };

  const toggleFeedsFrom = (id: string) => {
    setFeedsFromIds((prev) =>
      prev.includes(id) ? prev.filter((d) => d !== id) : [...prev, id]
    );
  };

  const colors = STAGE_TYPE_COLORS[stageType];
  const branchPreview =
    autoBranch && stageType === "task" && name.trim()
      ? generateBranchName(name.trim(), autoBranchPrefix)
      : null;

  return (
    <div
      className={`flex flex-col gap-3 rounded-lg border bg-maestro-surface/50 p-3 ${colors.card}`}
    >
      {/* Stage type selector */}
      <div className="flex flex-col gap-1">
        <label className="text-[10px] text-maestro-muted">Stage type</label>
        <div className="flex rounded overflow-hidden border border-maestro-border">
          {(["task", "review", "tester", "pr"] as StageType[]).map((t) => (
            <button
              key={t}
              type="button"
              onClick={() => handleTypeChange(t)}
              className={`flex flex-1 items-center justify-center gap-1 py-1 text-[10px] font-medium transition-colors capitalize ${
                stageType === t
                  ? `${STAGE_TYPE_COLORS[t].badge}`
                  : "bg-maestro-bg text-maestro-muted hover:text-maestro-text"
              }`}
            >
              {stageTypeIcon(t, 9)}
              {t}
            </button>
          ))}
        </div>
      </div>

      {/* Name + Session */}
      <div className="grid grid-cols-2 gap-2">
        <div className="flex flex-col gap-1">
          <label className="text-[10px] text-maestro-muted">Stage name</label>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={
              stageType === "review"
                ? "e.g. Code Review"
                : stageType === "tester"
                ? "e.g. Run Tests"
                : stageType === "pr"
                ? "e.g. Open PR"
                : "e.g. Auth Feature"
            }
            className="rounded border border-maestro-border bg-maestro-bg px-2 py-1 text-xs text-maestro-text placeholder:text-maestro-muted/50 focus:border-maestro-accent/60 focus:outline-none"
          />
        </div>
        <div className="flex flex-col gap-1">
          <label className="text-[10px] text-maestro-muted">Session</label>
          <select
            value={sessionId}
            onChange={(e) => setSessionId(Number(e.target.value))}
            className="rounded border border-maestro-border bg-maestro-bg px-2 py-1 text-xs text-maestro-text focus:border-maestro-accent/60 focus:outline-none"
          >
            {sessions.map((s) => (
              <option key={s.id} value={s.id}>
                Session {s.id}
                {s.branch ? ` · ${s.branch}` : ""}
              </option>
            ))}
            {sessions.length === 0 && <option value="">No sessions</option>}
          </select>
        </div>
      </div>

      {/* Prompt textarea with AI enhance and image paste */}
      <div className="flex flex-col gap-1">
        <div className="flex items-center gap-1">
          <label className="text-[10px] text-maestro-muted flex-1">
            {stageType === "review"
              ? "Reviewer instructions (sent with each review item)"
              : stageType === "tester"
              ? "Tester instructions (sent when reviewer approves)"
              : "Task prompt (sent to session)"}
          </label>
          <button
            type="button"
            onClick={handleEnhance}
            disabled={isEnhancing || !taskPrompt.trim()}
            title="Enhance with AI"
            className="flex items-center gap-0.5 rounded px-1.5 py-0.5 text-[10px] text-maestro-muted hover:text-maestro-accent hover:bg-maestro-accent/10 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {isEnhancing ? (
              <Loader2 size={9} className="animate-spin" />
            ) : (
              <Sparkles size={9} />
            )}
            <span>AI enhance</span>
          </button>
        </div>
        <div onPaste={handlePaste}>
          <textarea
            value={taskPrompt}
            onChange={(e) => setTaskPrompt(e.target.value)}
            placeholder={
              stageType === "review"
                ? "Review the code for correctness, security, and test coverage…"
                : stageType === "tester"
                ? "Run all unit and integration tests. Check for regressions…"
                : "Full task description to send to Claude…"
            }
            rows={3}
            className="w-full resize-none rounded border border-maestro-border bg-maestro-bg px-2 py-1.5 text-xs text-maestro-text placeholder:text-maestro-muted/50 focus:border-maestro-accent/60 focus:outline-none"
          />
        </div>
        {enhanceError && (
          <p className="text-[10px] text-red-400">{enhanceError}</p>
        )}
        {attachedImages.length > 0 && (
          <div className="flex flex-wrap gap-1.5 mt-0.5">
            {attachedImages.map((img, i) => (
              <div key={i} className="relative group">
                {img.previewUrl ? (
                  <img
                    src={img.previewUrl}
                    className="h-10 w-10 rounded object-cover border border-maestro-border"
                    alt={`attached ${i + 1}`}
                  />
                ) : (
                  <div className="h-10 flex items-center rounded border border-maestro-border bg-maestro-surface px-1.5">
                    <span className="text-[9px] text-maestro-muted truncate max-w-[80px]">
                      {img.path.split("/").pop()}
                    </span>
                  </div>
                )}
                <button
                  type="button"
                  onClick={() => setAttachedImages((prev) => prev.filter((_, j) => j !== i))}
                  className="absolute -top-1 -right-1 hidden group-hover:flex h-3.5 w-3.5 items-center justify-center rounded-full bg-red-500 text-white"
                >
                  <X size={7} />
                </button>
              </div>
            ))}
            <div className="flex items-center">
              <span className="text-[9px] text-maestro-muted/60">
                {attachedImages.length} image{attachedImages.length > 1 ? "s" : ""} attached
              </span>
            </div>
          </div>
        )}
        <p className="text-[9px] text-maestro-muted/40 flex items-center gap-0.5">
          <ImagePlus size={8} />
          Paste an image (Cmd+V) to attach it to this prompt
        </p>
      </div>

      {/* Review stage: feeds from */}
      {stageType === "review" && availableStages.filter((s) => s.type !== "review").length > 0 && (
        <div className="flex flex-col gap-1">
          <label className="text-[10px] text-maestro-muted">
            Reviews work from (any of these completing queues this reviewer)
          </label>
          <div className="flex flex-wrap gap-1.5">
            {availableStages
              .filter((s) => s.type !== "review")
              .map((stage) => (
                <button
                  key={stage.id}
                  type="button"
                  onClick={() => toggleFeedsFrom(stage.id)}
                  className={`rounded px-2 py-0.5 text-[10px] transition-colors ${
                    feedsFromIds.includes(stage.id)
                      ? "bg-purple-400/20 text-purple-400 border border-purple-400/40"
                      : "bg-maestro-surface text-maestro-muted border border-maestro-border hover:text-maestro-text"
                  }`}
                >
                  {stage.name}
                </button>
              ))}
          </div>
        </div>
      )}

      {/* Depends on */}
      {availableStages.length > 0 && (
        <div className="flex flex-col gap-1">
          <label className="text-[10px] text-maestro-muted">
            Depends on (ALL must complete before this stage starts)
          </label>
          <div className="flex flex-wrap gap-1.5">
            {availableStages.map((stage) => (
              <button
                key={stage.id}
                type="button"
                onClick={() => toggleDep(stage.id)}
                className={`rounded px-2 py-0.5 text-[10px] transition-colors ${
                  depIds.includes(stage.id)
                    ? "bg-maestro-accent/20 text-maestro-accent border border-maestro-accent/40"
                    : "bg-maestro-surface text-maestro-muted border border-maestro-border hover:text-maestro-text"
                }`}
              >
                {stage.name}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Session lifecycle */}
      <div className="flex flex-col gap-1">
        <label className="text-[10px] text-maestro-muted">Session lifecycle</label>
        <select
          value={lifecycle}
          onChange={(e) => setLifecycle(e.target.value as SessionLifecycle)}
          className="rounded border border-maestro-border bg-maestro-bg px-2 py-1 text-xs text-maestro-text focus:border-maestro-accent/60 focus:outline-none"
        >
          <option value="fresh-on-rework">Fresh on rework — /clear context when changes sent back</option>
          <option value="always-fresh">Always fresh — /clear context before each activation</option>
          <option value="persistent">Persistent — keep conversation context across rounds</option>
        </select>
      </div>

      {/* Auto-branch toggle (task stages only) */}
      {stageType === "task" && (
        <div className="flex flex-col gap-1.5">
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => setAutoBranch(!autoBranch)}
              className={`flex h-4 w-7 items-center rounded-full transition-colors shrink-0 ${
                autoBranch ? "bg-maestro-accent" : "bg-maestro-border"
              }`}
              aria-label="Toggle auto-branch"
            >
              <span
                className={`h-3 w-3 rounded-full bg-white shadow transition-transform ${
                  autoBranch ? "translate-x-3.5" : "translate-x-0.5"
                }`}
              />
            </button>
            <span className="text-[10px] text-maestro-muted flex-1">
              Auto-create git branch when this stage fires
            </span>
            {autoBranch && (
              <select
                value={autoBranchPrefix}
                onChange={(e) => setAutoBranchPrefix(e.target.value)}
                className="rounded border border-maestro-border bg-maestro-bg px-1.5 py-0.5 text-[10px] text-maestro-text focus:outline-none"
              >
                <option value="feature/">feature/</option>
                <option value="fix/">fix/</option>
                <option value="feat/">feat/</option>
                <option value="chore/">chore/</option>
              </select>
            )}
          </div>
          {branchPreview && (
            <p className="text-[9px] text-maestro-muted/60 pl-9">
              → <span className="font-mono">{branchPreview}</span>
            </p>
          )}
        </div>
      )}

      {/* Routing rules */}
      {availableStages.length > 0 && (
        <RoutingRuleEditor
          rules={routingRules}
          stages={availableStages}
          currentStageId={editStage?.id}
          onChange={setRoutingRules}
          stageType={stageType}
        />
      )}

      {/* Auto-send toggle */}
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={() => setAutoSend(!autoSend)}
          className={`flex h-4 w-7 items-center rounded-full transition-colors ${
            autoSend ? "bg-maestro-accent" : "bg-maestro-border"
          }`}
          aria-label="Toggle auto-send"
        >
          <span
            className={`h-3 w-3 rounded-full bg-white shadow transition-transform ${
              autoSend ? "translate-x-3.5" : "translate-x-0.5"
            }`}
          />
        </button>
        <span className="text-[10px] text-maestro-muted">Auto-send when deps complete</span>
      </div>

      {/* Ruflo memory toggle */}
      <label className="flex items-center gap-2 text-xs text-maestro-muted cursor-pointer">
        <input
          type="checkbox"
          checked={useRufloMemory}
          onChange={(e) => setUseRufloMemory(e.target.checked)}
          className="accent-maestro-accent"
        />
        Use Ruflo memory (requires Ruflo MCP installed)
      </label>

      {/* Actions */}
      <div className="flex justify-end gap-2">
        <button
          type="button"
          onClick={onDone}
          className="rounded px-3 py-1 text-xs text-maestro-muted hover:text-maestro-text transition-colors"
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={handleSubmit}
          disabled={!name.trim() || sessionId === "" || !taskPrompt.trim()}
          className={`rounded border px-3 py-1 text-xs transition-colors disabled:opacity-40 disabled:cursor-not-allowed ${colors.badge} hover:opacity-80`}
        >
          {isEditing ? "Save Changes" : "Add Stage"}
        </button>
      </div>
    </div>
  );
}

// ─── Approvals tab ────────────────────────────────────────────────────────────

function ApprovalsTab() {
  const allApprovals = usePipelineStore((s) => s.pendingApprovals);
  const approvals = useMemo(
    () => allApprovals.filter((a) => a.status === "pending"),
    [allApprovals]
  );
  const approveRequest = usePipelineStore((s) => s.approveRequest);
  const rejectRequest = usePipelineStore((s) => s.rejectRequest);
  const [feedbacks, setFeedbacks] = useState<Record<string, string>>({});
  const [showFeedback, setShowFeedback] = useState<Record<string, boolean>>({});

  if (approvals.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center gap-2 py-8 text-maestro-muted">
        <span className="text-xs">No pending approvals</span>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2 overflow-y-auto h-full">
      {approvals.map((req: HumanApprovalRequest) => (
        <div
          key={req.id}
          className="flex flex-col gap-2 rounded-lg border border-orange-400/30 bg-orange-400/5 p-3"
        >
          <div className="flex items-center gap-2">
            <FlaskConical size={10} className="text-orange-400 shrink-0" />
            <span className="text-[10px] font-medium text-orange-400">{req.stageName}</span>
            {req.branch && (
              <span className="text-[9px] text-maestro-muted/70">· {req.branch}</span>
            )}
            <span className="ml-auto text-[9px] text-maestro-muted/50">
              {new Date(req.addedAt).toLocaleTimeString()}
            </span>
          </div>
          <p className="text-xs text-maestro-text">{req.message}</p>

          {showFeedback[req.id] ? (
            <>
              <textarea
                value={feedbacks[req.id] ?? ""}
                onChange={(e) =>
                  setFeedbacks((p) => ({ ...p, [req.id]: e.target.value }))
                }
                placeholder="Describe what's wrong…"
                rows={3}
                className="w-full resize-none rounded border border-maestro-border bg-maestro-bg px-2 py-1.5 text-xs text-maestro-text placeholder:text-maestro-muted/50 focus:border-red-400/60 focus:outline-none"
              />
              <div className="flex gap-2 justify-end">
                <button
                  type="button"
                  onClick={() => setShowFeedback((p) => ({ ...p, [req.id]: false }))}
                  className="rounded px-3 py-1 text-xs text-maestro-muted hover:text-maestro-text transition-colors"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={() => rejectRequest(req.id, feedbacks[req.id] ?? "")}
                  disabled={!feedbacks[req.id]?.trim()}
                  className="rounded border border-red-400/30 bg-red-400/10 px-3 py-1 text-xs text-red-400 hover:bg-red-400/20 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  Send Feedback
                </button>
              </div>
            </>
          ) : (
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => approveRequest(req.id)}
                className="flex-1 rounded border border-green-400/30 bg-green-400/10 py-1 text-xs text-green-400 hover:bg-green-400/20 transition-colors"
              >
                ✓ Approve → PR
              </button>
              <button
                type="button"
                onClick={() => setShowFeedback((p) => ({ ...p, [req.id]: true }))}
                className="flex-1 rounded border border-red-400/30 bg-red-400/10 py-1 text-xs text-red-400 hover:bg-red-400/20 transition-colors"
              >
                ✗ Reject
              </button>
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

// ─── DAG layout helpers ───────────────────────────────────────────────────────

const CARD_H = 72;
const CARD_GAP = 8;
const CARD_PITCH = CARD_H + CARD_GAP;
const CARD_W = 184;
const GUTTER_W = 44;

/**
 * Assigns each stage to a column based on its longest dependency chain.
 * Stages with no dependencies go in column 0; a stage's column is
 * max(dependency columns) + 1.
 */
function computeColumns(stages: PipelineStage[]): Map<string, number> {
  const cols = new Map<string, number>();
  const visiting = new Set<string>();
  function getCol(id: string): number {
    if (cols.has(id)) return cols.get(id)!;
    if (visiting.has(id)) { cols.set(id, 0); return 0; } // cycle guard
    const stage = stages.find((s) => s.id === id);
    if (!stage || stage.dependsOn.length === 0) { cols.set(id, 0); return 0; }
    visiting.add(id);
    const c = Math.max(...stage.dependsOn.map(getCol)) + 1;
    visiting.delete(id);
    cols.set(id, c);
    return c;
  }
  stages.forEach((s) => getCol(s.id));
  return cols;
}

// ─── Pipeline tab ─────────────────────────────────────────────────────────────

function PipelineTab() {
  const stages = usePipelineStore((s) => s.stages);
  const isEnabled = usePipelineStore((s) => s.isEnabled);
  const toggleEnabled = usePipelineStore((s) => s.toggleEnabled);
  const removeStage = usePipelineStore((s) => s.removeStage);
  const updateStage = usePipelineStore((s) => s.updateStage);
  const buildTesterPrompt = usePipelineStore((s) => s.buildTesterPrompt);
  const clearAll = usePipelineStore((s) => s.clearAll);
  const onSessionDone = usePipelineStore((s) => s.onSessionDone);
  const reorderStages = usePipelineStore((s) => s.reorderStages);
  const loadPreset = usePipelineStore((s) => s.loadPreset);
  const templates = usePipelineStore((s) => s.templates);
  const saveTemplate = usePipelineStore((s) => s.saveTemplate);
  const deleteTemplate = usePipelineStore((s) => s.deleteTemplate);
  const processReviewQueue = usePipelineStore((s) => s.processReviewQueue);
  const sessions = useSessionStore((s) => s.sessions);

  const [showAddForm, setShowAddForm] = useState(false);
  const [stageErrors, setStageErrors] = useState<Record<string, string>>({});
  const [editingStageId, setEditingStageId] = useState<string | null>(null);
  const [showTemplateMenu, setShowTemplateMenu] = useState(false);
  const [templateName, setTemplateName] = useState("");
  const templateMenuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!showTemplateMenu) return;
    const handleMouseDown = (e: MouseEvent) => {
      if (templateMenuRef.current && !templateMenuRef.current.contains(e.target as Node)) {
        setShowTemplateMenu(false);
      }
    };
    document.addEventListener("mousedown", handleMouseDown);
    return () => document.removeEventListener("mousedown", handleMouseDown);
  }, [showTemplateMenu]);

  // DAG layout: assign each stage to a column, group into column arrays
  const colMap = useMemo(() => computeColumns(stages), [stages]);
  const dagColumns = useMemo(() => {
    if (stages.length === 0) return [];
    const numCols = Math.max(0, ...Array.from(colMap.values())) + 1;
    const cols: PipelineStage[][] = Array.from({ length: numCols }, () => []);
    stages.forEach((stage) => {
      const c = colMap.get(stage.id) ?? 0;
      cols[c].push(stage);
    });
    return cols;
  }, [stages, colMap]);

  const handleRerun = useCallback(
    (stage: PipelineStage) => {
      updateStage(stage.id, { status: "pending", sourceStatusMessage: null, sourceBranch: null });
    },
    [updateStage]
  );

  const handleManualSend = async (stage: PipelineStage) => {
    // Guard: session must be alive before we try to write to it
    const liveSession = sessions.find((s) => s.id === stage.sessionId);
    if (!liveSession) {
      setStageErrors((prev) => ({
        ...prev,
        [stage.id]: `Session ${stage.sessionId} not found — is it running?`,
      }));
      return;
    }
    if (!stage.taskPrompt.trim()) {
      setStageErrors((prev) => ({ ...prev, [stage.id]: "Task prompt is empty" }));
      return;
    }

    // Clear any previous error for this stage
    setStageErrors((prev) => { const n = { ...prev }; delete n[stage.id]; return n; });

    // For review stages: use processReviewQueue if items are waiting
    if (stage.type === "review") {
      const freshStage = stages.find((s) => s.id === stage.id);
      const hasWaiting = freshStage?.reviewQueue.some((item) => item.reviewStatus === "waiting");
      if (hasWaiting) {
        processReviewQueue(stage.id);
        return;
      }
      setStageErrors((prev) => ({
        ...prev,
        [stage.id]: "No work queued yet — waiting for an upstream task stage to finish.",
      }));
      return;
    }

    try {
      let promptText = stage.taskPrompt;
      if (stage.autoBranch && stage.type === "task") {
        const branch = generateBranchName(stage.name, stage.autoBranchPrefix);
        updateStage(stage.id, { sourceBranch: branch });
        promptText = [
          `First, create a new git branch for this work:`,
          `  git checkout -b ${branch}`,
          ``,
          `Then:`,
          stage.taskPrompt,
        ].join("\n");
      } else if (stage.type === "tester") {
        const freshStage = stages.find((s) => s.id === stage.id) ?? stage;
        promptText = buildTesterPrompt(freshStage);
      }
      const imagePaths = (stage.attachedImages ?? []).map((img) => img.path).join(" ");
      const fullPrompt = imagePaths ? `${imagePaths} ${promptText}` : promptText;
      await sendPromptToSession(stage.sessionId, fullPrompt);
      updateStage(stage.id, { status: "running" });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setStageErrors((prev) => ({ ...prev, [stage.id]: msg }));
      console.error("[Pipeline] Manual send failed:", err);
    }
  };

  const queueBadge = (stage: PipelineStage) => {
    if (stage.type !== "review") return null;
    const waitingCount = stage.reviewQueue.filter((i) => i.reviewStatus === "waiting").length;
    if (waitingCount === 0) return null;
    return (
      <span className="rounded-full bg-purple-400/20 px-1.5 py-px text-[9px] font-medium text-purple-400 shrink-0">
        {waitingCount}
      </span>
    );
  };

  return (
    <div className="flex flex-col gap-3 overflow-y-auto h-full">
      {/* Pipeline controls */}
      <div className="flex items-center gap-2 shrink-0">
        <button
          type="button"
          onClick={toggleEnabled}
          className={`flex h-5 w-9 items-center rounded-full transition-colors ${
            isEnabled ? "bg-maestro-accent" : "bg-maestro-border"
          }`}
          aria-label="Toggle pipeline"
        >
          <span
            className={`h-4 w-4 rounded-full bg-white shadow transition-transform ${
              isEnabled ? "translate-x-[18px]" : "translate-x-0.5"
            }`}
          />
        </button>
        <span className="text-xs text-maestro-muted">
          {isEnabled ? "Pipeline active — auto-send on Done" : "Pipeline paused"}
        </span>
        <div className="flex-1" />

        {/* Templates dropdown */}
        <div className="relative" ref={templateMenuRef}>
          <button
            type="button"
            onClick={() => setShowTemplateMenu((v) => !v)}
            className="flex items-center gap-1 rounded border border-maestro-border bg-maestro-surface px-2 py-1 text-[10px] text-maestro-muted hover:text-maestro-text transition-colors"
          >
            <Layers size={10} />
            Templates
          </button>
          {showTemplateMenu && (
            <div className="absolute right-0 top-full mt-1 z-50 w-56 rounded-lg border border-maestro-border bg-maestro-surface shadow-lg">
              {/* Save current pipeline */}
              <div className="border-b border-maestro-border p-2 flex flex-col gap-1.5">
                <span className="text-[10px] text-maestro-muted font-medium">Save current pipeline</span>
                <div className="flex gap-1">
                  <input
                    type="text"
                    value={templateName}
                    onChange={(e) => setTemplateName(e.target.value)}
                    placeholder="Template name…"
                    className="flex-1 min-w-0 rounded border border-maestro-border bg-maestro-bg px-2 py-0.5 text-[10px] text-maestro-text placeholder:text-maestro-muted/50 focus:border-maestro-accent/60 focus:outline-none"
                  />
                  <button
                    type="button"
                    onClick={() => {
                      if (!templateName.trim() || stages.length === 0) return;
                      saveTemplate(templateName);
                      setTemplateName("");
                      setShowTemplateMenu(false);
                    }}
                    disabled={!templateName.trim() || stages.length === 0}
                    className="shrink-0 rounded border border-maestro-border bg-maestro-bg px-2 py-0.5 text-[10px] text-maestro-muted hover:text-maestro-text disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                  >
                    Save
                  </button>
                </div>
              </div>
              {/* Saved templates list */}
              {templates.length > 0 && (
                <div className="border-b border-maestro-border p-1.5 flex flex-col gap-0.5 max-h-32 overflow-y-auto">
                  {templates.map((t: PipelineTemplate) => (
                    <div key={t.id} className="flex items-center gap-1 rounded px-1 py-0.5 hover:bg-maestro-hi/20">
                      <span className="flex-1 text-[10px] text-maestro-text truncate min-w-0">{t.name}</span>
                      <button
                        type="button"
                        onClick={() => { loadPreset(t.stages); setShowTemplateMenu(false); }}
                        className="shrink-0 text-[10px] text-maestro-accent hover:opacity-80 px-1 transition-colors"
                      >
                        Load
                      </button>
                      <button
                        type="button"
                        onClick={() => deleteTemplate(t.id)}
                        className="shrink-0 text-[10px] text-maestro-muted hover:text-red-400 transition-colors"
                      >
                        ✕
                      </button>
                    </div>
                  ))}
                </div>
              )}
              {/* Clear pipeline */}
              <div className="p-1.5">
                <button
                  type="button"
                  onClick={() => { clearAll(); setShowTemplateMenu(false); }}
                  disabled={stages.length === 0}
                  className="w-full flex items-center justify-center gap-1 rounded px-2 py-1 text-[10px] text-red-400/70 hover:text-red-400 hover:bg-red-400/10 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                >
                  <Trash2 size={9} />
                  Clear pipeline
                </button>
              </div>
            </div>
          )}
        </div>

        <button
          type="button"
          onClick={() => { setShowAddForm(true); setEditingStageId(null); }}
          className="flex items-center gap-1 rounded border border-maestro-border bg-maestro-surface px-2 py-1 text-[10px] text-maestro-muted hover:text-maestro-text transition-colors"
        >
          <Plus size={10} />
          Add stage
        </button>
      </div>

      {/* Add / edit stage forms — shown full-width above the DAG */}
      {showAddForm && <StageForm onDone={() => setShowAddForm(false)} />}
      {editingStageId && (
        <StageForm
          editStage={stages.find((s) => s.id === editingStageId)}
          onDone={() => {
            // Clear any stale error for this stage — the user just re-saved it
            setStageErrors((prev) => { const n = { ...prev }; delete n[editingStageId]; return n; });
            setEditingStageId(null);
          }}
        />
      )}

      {/* Empty state */}
      {stages.length === 0 && !showAddForm && (
        <div className="flex flex-col items-center justify-center gap-2 py-8 text-maestro-muted">
          <Network size={24} className="opacity-30" />
          <span className="text-xs">No stages yet. Add a stage to build your pipeline.</span>
        </div>
      )}

      {/* Horizontal DAG */}
      {stages.length > 0 && (
        <div className="overflow-x-auto overflow-y-visible pb-2 shrink-0">
          <div className="flex items-start" style={{ minWidth: "min-content" }}>
            {dagColumns.map((col, colIdx) => {
              const nextCol = dagColumns[colIdx + 1];

              // Compute gutter paths between this column and the next
              const gutterPaths: {
                d: string;
                y2: number;
                color: string;
                dashed: boolean;
                key: string;
              }[] = [];
              if (nextCol) {
                nextCol.forEach((rStage, rIdx) => {
                  rStage.dependsOn.forEach((depId) => {
                    const lIdx = col.findIndex((s) => s.id === depId);
                    if (lIdx < 0) return;
                    const y1 = lIdx * CARD_PITCH + CARD_H / 2;
                    const y2 = rIdx * CARD_PITCH + CARD_H / 2;
                    gutterPaths.push({
                      d: `M 2 ${y1} C ${GUTTER_W / 2} ${y1} ${GUTTER_W / 2} ${y2} ${GUTTER_W - 8} ${y2}`,
                      y2,
                      color: "#8a89f1",
                      dashed: false,
                      key: `dep-${depId}-${rStage.id}`,
                    });
                  });
                  rStage.feedsFromStages.forEach((feedId) => {
                    const lIdx = col.findIndex((s) => s.id === feedId);
                    if (lIdx < 0) return;
                    const y1 = lIdx * CARD_PITCH + CARD_H / 2;
                    const y2 = rIdx * CARD_PITCH + CARD_H / 2;
                    gutterPaths.push({
                      d: `M 2 ${y1} C ${GUTTER_W / 2} ${y1} ${GUTTER_W / 2} ${y2} ${GUTTER_W - 8} ${y2}`,
                      y2,
                      color: "#c084fc",
                      dashed: true,
                      key: `feed-${feedId}-${rStage.id}`,
                    });
                  });
                });
              }

              return (
                <Fragment key={colIdx}>
                  {/* Column of stage cards */}
                  <div
                    className="flex flex-col shrink-0"
                    style={{ width: CARD_W, gap: CARD_GAP }}
                  >
                    {col.map((stage) => {
                      const colors = STAGE_TYPE_COLORS[stage.type] ?? STAGE_TYPE_COLORS.task;
                      return (
                        <div
                          key={stage.id}
                          className={`rounded-lg border bg-maestro-surface overflow-hidden ${
                            stageErrors[stage.id] ? "border-amber-400/60" : colors.card
                          }`}
                          style={{ height: CARD_H, width: CARD_W }}
                        >
                          <div className="flex flex-col justify-between h-full p-2">
                            {/* Row 1: type badge · name · status · queue · error icon */}
                            <div className="flex items-center gap-1 min-w-0">
                              <span className={`flex items-center rounded px-1 py-0.5 shrink-0 ${colors.badge}`}>
                                {stageTypeIcon(stage.type, 9)}
                              </span>
                              <span className="text-[11px] font-medium text-maestro-text truncate flex-1 min-w-0">
                                {stage.name}
                              </span>
                              <StageBadge status={stage.status} />
                              {queueBadge(stage)}
                              {stageErrors[stage.id] && (
                                <span
                                  title={stageErrors[stage.id]}
                                  className="shrink-0 text-amber-400 cursor-help"
                                >
                                  <AlertTriangle size={10} />
                                </span>
                              )}
                            </div>

                            {/* Row 2: session · branch · routing chips · action buttons */}
                            <div className="flex items-center gap-1 text-[9px] text-maestro-muted/70 min-w-0">
                              <span className="shrink-0 text-maestro-muted/60">S{stage.sessionId}</span>
                              {stage.type === "task" && stage.autoBranch && (
                                <span className="font-mono truncate min-w-0 text-[8px] text-maestro-muted/40 flex-1 mr-1">
                                  {generateBranchName(stage.name, stage.autoBranchPrefix).slice(0, 16)}
                                </span>
                              )}
                              <div className="flex items-center gap-0.5 ml-auto shrink-0">
                                {stage.routingRules.map((rule) => {
                                  const targetName =
                                    rule.targetStageId === "__source__"
                                      ? "src"
                                      : (stages.find((s) => s.id === rule.targetStageId)?.name ?? "…").slice(0, 5);
                                  return (
                                    <span
                                      key={rule.condition}
                                      className={`rounded px-0.5 py-px text-[8px] ${
                                        rule.condition === "approved"
                                          ? "bg-green-400/10 text-green-400"
                                          : "bg-red-400/10 text-red-400"
                                      }`}
                                    >
                                      {rule.condition === "approved" ? "✓" : "✗"}→{targetName}
                                    </span>
                                  );
                                })}
                                {/* Status-dependent action */}
                                {stage.status === "pending" && (
                                  <button
                                    type="button"
                                    onClick={() => handleManualSend(stage)}
                                    title="Send now"
                                    className="rounded p-0.5 text-maestro-muted hover:text-maestro-accent transition-colors"
                                  >
                                    <Play size={9} />
                                  </button>
                                )}
                                {stage.status === "running" && (
                                  <button
                                    type="button"
                                    onClick={() => onSessionDone(stage.sessionId, "")}
                                    title="Mark done"
                                    className="rounded p-0.5 text-maestro-muted hover:text-green-400 transition-colors"
                                  >
                                    <SkipForward size={9} />
                                  </button>
                                )}
                                {stage.status !== "pending" && (
                                  <button
                                    type="button"
                                    onClick={() => handleRerun(stage)}
                                    title="Rerun — reset to pending"
                                    className="rounded p-0.5 text-maestro-muted hover:text-maestro-accent transition-colors"
                                  >
                                    <RotateCcw size={9} />
                                  </button>
                                )}
                                {/* Reorder ▲▼ */}
                                {(() => {
                                  const idx = stages.findIndex((s) => s.id === stage.id);
                                  return (
                                    <>
                                      <button
                                        type="button"
                                        onClick={() => reorderStages(idx, idx - 1)}
                                        disabled={idx === 0}
                                        title="Move earlier"
                                        className="rounded p-0.5 text-maestro-muted hover:text-maestro-text disabled:opacity-20 transition-colors"
                                      >
                                        <ArrowUp size={9} />
                                      </button>
                                      <button
                                        type="button"
                                        onClick={() => reorderStages(idx, idx + 1)}
                                        disabled={idx === stages.length - 1}
                                        title="Move later"
                                        className="rounded p-0.5 text-maestro-muted hover:text-maestro-text disabled:opacity-20 transition-colors"
                                      >
                                        <ArrowDown size={9} />
                                      </button>
                                    </>
                                  );
                                })()}
                                {/* Edit */}
                                <button
                                  type="button"
                                  onClick={() => { setEditingStageId(stage.id); setShowAddForm(false); }}
                                  title="Edit"
                                  className="rounded p-0.5 text-maestro-muted hover:text-maestro-accent transition-colors"
                                >
                                  <Pencil size={9} />
                                </button>
                                {/* Remove */}
                                <button
                                  type="button"
                                  onClick={() => removeStage(stage.id)}
                                  title="Remove"
                                  className="rounded p-0.5 text-maestro-muted hover:text-red-400 transition-colors"
                                >
                                  <X size={9} />
                                </button>
                              </div>
                            </div>
                          </div>
                        </div>
                      );
                    })}
                  </div>

                  {/* Gutter SVG between this column and the next */}
                  {nextCol && (
                    <svg
                      width={GUTTER_W}
                      height={Math.max(col.length, nextCol.length) * CARD_PITCH - CARD_GAP}
                      style={{ flexShrink: 0, overflow: "visible", alignSelf: "flex-start" }}
                    >
                      {gutterPaths.map(({ d, y2, color, dashed, key }) => (
                        <g key={key}>
                          <path
                            d={d}
                            stroke={color}
                            strokeWidth={1.5}
                            fill="none"
                            strokeDasharray={dashed ? "3 2" : undefined}
                            opacity={0.7}
                          />
                          <polygon
                            points={`${GUTTER_W - 8},${y2 - 3.5} ${GUTTER_W - 1},${y2} ${GUTTER_W - 8},${y2 + 3.5}`}
                            fill={color}
                            opacity={0.7}
                          />
                        </g>
                      ))}
                    </svg>
                  )}
                </Fragment>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Control tab ─────────────────────────────────────────────────────────────

function ControlTab() {
  const sessions = useSessionStore((s) => s.sessions);
  const getStagesForSession = usePipelineStore((s) => s.getStagesForSession);

  const getCurrentStage = (sessionId: number) => {
    const stages = getStagesForSession(sessionId);
    return stages.find((s) => s.status === "running") ?? stages.find((s) => s.status === "pending");
  };

  if (sessions.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center gap-2 py-8 text-maestro-muted">
        <span className="text-xs">No active sessions. Open a project and launch sessions.</span>
      </div>
    );
  }

  return (
    <div
      className="grid gap-2 overflow-y-auto"
      style={{ gridTemplateColumns: "repeat(auto-fill, minmax(260px, 1fr))" }}
    >
      {sessions.map((session) => (
        <SessionControlRow
          key={session.id}
          session={session}
          currentStage={getCurrentStage(session.id)}
        />
      ))}
    </div>
  );
}

// ─── Main panel ──────────────────────────────────────────────────────────────

interface OrchestratorPanelProps {
  onClose: () => void;
}

export function OrchestratorPanel({ onClose }: OrchestratorPanelProps) {
  const [tab, setTab] = useState<"control" | "pipeline" | "approvals">("control");
  const stages = usePipelineStore((s) => s.stages);
  const isEnabled = usePipelineStore((s) => s.isEnabled);
  const allPendingApprovals = usePipelineStore((s) => s.pendingApprovals);
  const pendingApprovals = useMemo(
    () => allPendingApprovals.filter((a) => a.status === "pending"),
    [allPendingApprovals]
  );

  const runningCount = useMemo(() => stages.filter((s) => s.status === "running").length, [stages]);
  const pendingCount = useMemo(() => stages.filter((s) => s.status === "pending").length, [stages]);
  const queueCount = useMemo(
    () =>
      stages.reduce(
        (sum, s) => sum + s.reviewQueue.filter((i) => i.reviewStatus === "waiting").length,
        0
      ),
    [stages]
  );

  return (
    <div
      className="flex flex-col border-t border-maestro-border bg-maestro-bg shrink-0"
      style={{ height: 320 }}
    >
      {/* Panel header */}
      <div className="flex h-8 shrink-0 items-center gap-2 border-b border-maestro-border px-3">
        <Network size={13} className="text-maestro-accent" />
        <span className="text-xs font-medium text-maestro-text">Orchestrator</span>

        {/* Pipeline status pills */}
        {stages.length > 0 && (
          <div className="flex items-center gap-1 ml-1">
            {runningCount > 0 && (
              <span className="rounded-full bg-yellow-400/20 px-1.5 py-px text-[9px] font-medium text-yellow-400">
                {runningCount} running
              </span>
            )}
            {pendingCount > 0 && (
              <span className="rounded-full bg-maestro-muted/20 px-1.5 py-px text-[9px] font-medium text-maestro-muted">
                {pendingCount} pending
              </span>
            )}
            {queueCount > 0 && (
              <span className="rounded-full bg-purple-400/20 px-1.5 py-px text-[9px] font-medium text-purple-400">
                {queueCount} in queue
              </span>
            )}
            {isEnabled && (
              <span className="rounded-full bg-maestro-accent/20 px-1.5 py-px text-[9px] font-medium text-maestro-accent">
                auto
              </span>
            )}
          </div>
        )}

        <div className="flex-1" />

        {/* Tabs */}
        <div className="flex rounded border border-maestro-border overflow-hidden">
          {(["control", "pipeline", "approvals"] as const).map((t) => (
            <button
              key={t}
              type="button"
              onClick={() => setTab(t)}
              className={`relative px-2.5 py-0.5 text-[10px] font-medium transition-colors capitalize ${
                tab === t
                  ? "bg-maestro-accent/15 text-maestro-accent"
                  : "text-maestro-muted hover:text-maestro-text bg-maestro-surface"
              }`}
            >
              {t}
              {/* Orange badge for pending approvals on the approvals tab */}
              {t === "approvals" && pendingApprovals.length > 0 && (
                <span className="absolute -top-1 -right-1 flex h-3.5 w-3.5 items-center justify-center rounded-full bg-orange-400 text-[8px] font-bold text-black">
                  {pendingApprovals.length}
                </span>
              )}
            </button>
          ))}
        </div>

        {/* Collapse button */}
        <button
          type="button"
          onClick={onClose}
          className="rounded p-0.5 text-maestro-muted hover:text-maestro-text transition-colors"
          aria-label="Close orchestrator"
        >
          <ChevronDown size={13} />
        </button>
      </div>

      {/* Panel body */}
      <div className="flex-1 overflow-hidden p-3">
        {tab === "control" && <ControlTab />}
        {tab === "pipeline" && <PipelineTab />}
        {tab === "approvals" && <ApprovalsTab />}
      </div>
    </div>
  );
}
