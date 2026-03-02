import { Clock, FlaskConical, GitBranch, ListChecks, Zap } from "lucide-react";
import { usePipelineStore, type PipelineStage, type StageType } from "@/stores/usePipelineStore";
import { useSessionStore } from "@/stores/useSessionStore";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function stageColor(type: StageType): {
  bg: string;
  border: string;
  text: string;
  icon: string;
} {
  switch (type) {
    case "review":
      return {
        bg: "bg-purple-400/10",
        border: "border-purple-400/40",
        text: "text-purple-300",
        icon: "text-purple-400",
      };
    case "tester":
      return {
        bg: "bg-orange-400/10",
        border: "border-orange-400/30",
        text: "text-orange-300",
        icon: "text-orange-400",
      };
    case "pr":
      return {
        bg: "bg-green-400/10",
        border: "border-green-400/40",
        text: "text-green-300",
        icon: "text-green-400",
      };
    default:
      return {
        bg: "bg-blue-400/10",
        border: "border-blue-400/30",
        text: "text-blue-300",
        icon: "text-blue-400",
      };
  }
}

function statusRing(status: PipelineStage["status"]): string {
  switch (status) {
    case "running":
      return "ring-1 ring-yellow-400/60";
    case "done":
      return "ring-1 ring-green-400/40";
    case "skipped":
      return "opacity-50";
    default:
      return "";
  }
}

function TypeIcon({ type, size = 11 }: { type: StageType; size?: number }) {
  if (type === "review") return <ListChecks size={size} />;
  if (type === "tester") return <FlaskConical size={size} />;
  if (type === "pr") return <GitBranch size={size} />;
  return <Zap size={size} />;
}

// ─── Single stage card ────────────────────────────────────────────────────────

interface StageCardProps {
  stage: PipelineStage;
  stages: PipelineStage[];
}

function StageCard({ stage, stages }: StageCardProps) {
  const sessions = useSessionStore((s) => s.sessions);
  const colors = stageColor(stage.type);
  const ring = statusRing(stage.status);

  const session = sessions.find((s) => s.id === stage.sessionId);
  const sessionLabel = session?.branch
    ? `S${stage.sessionId} · ${session.branch}`
    : `Session ${stage.sessionId}`;

  const waitingCount = stage.reviewQueue.filter((i) => i.reviewStatus === "waiting").length;
  const reviewingItem = stage.reviewQueue.find((i) => i.reviewStatus === "reviewing");

  // Routing targets for display
  const approvedTarget = stage.routingRules.find((r) => r.condition === "approved");
  const changesTarget = stage.routingRules.find((r) => r.condition === "changes_needed");

  const getTargetName = (targetId: string) => {
    if (targetId === "__source__") return "source";
    return stages.find((s) => s.id === targetId)?.name ?? "…";
  };

  return (
    <div
      className={`flex flex-col gap-1.5 rounded-lg border p-2.5 min-w-[140px] max-w-[180px] ${colors.bg} ${colors.border} ${ring}`}
    >
      {/* Type + name */}
      <div className="flex items-center gap-1.5">
        <span className={colors.icon}>
          <TypeIcon type={stage.type} />
        </span>
        <span className={`text-[11px] font-semibold truncate flex-1 ${colors.text}`}>
          {stage.name}
        </span>
      </div>

      {/* Session label */}
      <div className="text-[9px] text-maestro-muted/70 truncate">{sessionLabel}</div>

      {/* Status */}
      <div className="flex items-center gap-1.5">
        <StatusDot status={stage.status} />
        <span className="text-[9px] text-maestro-muted capitalize">{stage.status}</span>

        {/* Queue badge */}
        {waitingCount > 0 && (
          <span className="ml-auto rounded-full bg-purple-400/20 px-1 py-px text-[8px] font-medium text-purple-400">
            {waitingCount}
          </span>
        )}
      </div>

      {/* Currently reviewing */}
      {reviewingItem && (
        <div className="flex items-center gap-1">
          <Clock size={8} className="text-yellow-400 shrink-0" />
          <span className="text-[9px] text-yellow-400/80 truncate">
            {reviewingItem.sourceStageName}
          </span>
        </div>
      )}

      {/* Routing rules mini display */}
      {(approvedTarget || changesTarget) && (
        <div className="flex flex-col gap-0.5 mt-0.5">
          {approvedTarget && (
            <div className="flex items-center gap-1">
              <span className="text-[8px] text-green-400">✓→</span>
              <span className="text-[8px] text-green-400/70 truncate">
                {getTargetName(approvedTarget.targetStageId)}
              </span>
            </div>
          )}
          {changesTarget && (
            <div className="flex items-center gap-1">
              <span className="text-[8px] text-red-400">✗→</span>
              <span className="text-[8px] text-red-400/70 truncate">
                {getTargetName(changesTarget.targetStageId)}
              </span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function StatusDot({ status }: { status: PipelineStage["status"] }) {
  const colors: Record<PipelineStage["status"], string> = {
    running: "bg-yellow-400",
    done: "bg-green-400",
    pending: "bg-maestro-muted/40",
    skipped: "bg-maestro-muted/20",
  };
  return <span className={`inline-block h-1.5 w-1.5 rounded-full shrink-0 ${colors[status]}`} />;
}

// ─── Arrow between stages ─────────────────────────────────────────────────────

function Arrow() {
  return (
    <div className="flex items-center shrink-0 px-1 text-maestro-muted/40">
      <span className="text-sm">→</span>
    </div>
  );
}

// ─── Fan-in group ─────────────────────────────────────────────────────────────
// Renders multiple task stages feeding into one review stage

interface FanInGroupProps {
  sourceStages: PipelineStage[];
  reviewerStage: PipelineStage;
  allStages: PipelineStage[];
}

function FanInGroup({ sourceStages, reviewerStage, allStages }: FanInGroupProps) {
  return (
    <div className="flex items-center gap-0">
      {/* Source stages stacked vertically */}
      <div className="flex flex-col gap-2">
        {sourceStages.map((s) => (
          <StageCard key={s.id} stage={s} stages={allStages} />
        ))}
      </div>

      {/* Bracket arrows */}
      <div className="flex flex-col items-center justify-center px-2 self-stretch">
        <div className="flex flex-col items-center h-full justify-center gap-0">
          {sourceStages.map((_, i) => (
            <div key={i} className="flex-1 flex items-center">
              <div
                className={`border-t border-maestro-muted/30 w-4 ${
                  i === 0
                    ? "border-r rounded-tr"
                    : i === sourceStages.length - 1
                    ? "border-r rounded-br"
                    : "border-r"
                }`}
                style={{ height: "50%", alignSelf: i === 0 ? "flex-end" : "flex-start" }}
              />
            </div>
          ))}
        </div>
        <div className="text-maestro-muted/40 text-xs">→</div>
      </div>

      {/* Reviewer */}
      <StageCard stage={reviewerStage} stages={allStages} />
    </div>
  );
}

// ─── Main flow view ───────────────────────────────────────────────────────────

export function PipelineFlowView() {
  const stages = usePipelineStore((s) => s.stages);

  if (stages.length === 0) {
    return (
      <div className="flex items-center justify-center py-4 text-[10px] text-maestro-muted/50">
        No stages — add stages in the Pipeline tab
      </div>
    );
  }

  // Build a simple left-to-right layout:
  // 1. Group review stages with their source stages as fan-in clusters
  // 2. Remaining task/pr stages shown individually
  // 3. Connect with arrows based on dependsOn or feedsFromStages

  const reviewStages = stages.filter((s) => s.type === "review");
  const renderedStageIds = new Set<string>();

  interface FlowNode {
    type: "single" | "fanin";
    stage?: PipelineStage;
    sources?: PipelineStage[];
    reviewer?: PipelineStage;
  }

  const nodes: FlowNode[] = [];

  // Fan-in clusters first
  for (const reviewer of reviewStages) {
    if (reviewer.feedsFromStages.length > 0) {
      const sources = reviewer.feedsFromStages
        .map((id) => stages.find((s) => s.id === id))
        .filter(Boolean) as PipelineStage[];

      if (sources.length > 0) {
        nodes.push({ type: "fanin", sources, reviewer });
        for (const s of sources) renderedStageIds.add(s.id);
        renderedStageIds.add(reviewer.id);
      }
    }
  }

  // Remaining stages in order
  for (const stage of stages) {
    if (!renderedStageIds.has(stage.id)) {
      nodes.push({ type: "single", stage });
      renderedStageIds.add(stage.id);
    }
  }

  return (
    <div className="flex items-center gap-1 overflow-x-auto py-2 px-1 flex-wrap gap-y-3">
      {nodes.map((node, i) => (
        <div key={i} className="flex items-center gap-0">
          {i > 0 && <Arrow />}
          {node.type === "single" && node.stage && (
            <StageCard stage={node.stage} stages={stages} />
          )}
          {node.type === "fanin" && node.sources && node.reviewer && (
            <FanInGroup
              sourceStages={node.sources}
              reviewerStage={node.reviewer}
              allStages={stages}
            />
          )}
        </div>
      ))}
    </div>
  );
}
