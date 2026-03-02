import { LazyStore } from "@tauri-apps/plugin-store";
import { create } from "zustand";
import { createJSONStorage, persist, type StateStorage } from "zustand/middleware";
import { sendPromptToSession } from "@/lib/terminal";
import { useSessionStore } from "@/stores/useSessionStore";

// --- Types ---

export type PipelineStageStatus = "pending" | "running" | "done" | "skipped";
export type StageType = "task" | "review" | "tester" | "pr";
export type SessionLifecycle = "persistent" | "fresh-on-rework" | "always-fresh";

export interface RoutingRule {
  condition: "approved" | "changes_needed";
  /** Keywords in statusMessage that trigger this condition (case-insensitive) */
  keywords: string[];
  /**
   * Stage ID to trigger when this condition is met.
   * Use "__source__" to route back to the source stage from the review queue item.
   */
  targetStageId: string;
}

export interface PipelineTemplate {
  id: string;
  name: string;
  createdAt: number;
  stages: Omit<PipelineStage, "id" | "status">[];
}

export interface ReviewQueueItem {
  id: string;
  /** Which pipeline stage produced this work */
  sourceStageId: string;
  /** Which session did the work */
  sourceSessionId: number;
  /** Branch the work was done on (for review prompt context) */
  sourceBranch: string | null;
  /** Human name of the source stage */
  sourceStageName: string;
  /** What the agent said when it finished */
  sourceStatusMessage: string | null;
  addedAt: number;
  reviewStatus: "waiting" | "reviewing" | "done";
}

export interface HumanApprovalRequest {
  id: string;
  stageId: string;
  stageName: string;
  branch: string | null;
  /** What the tester reported needing approval for */
  message: string;
  addedAt: number;
  status: "pending" | "approved" | "rejected";
}

export interface PipelineStage {
  id: string;
  /** Stage type: task (worker), review (reviewer), tester (test runner), pr (pull request) */
  type: StageType;
  sessionId: number;
  name: string;
  /** Base prompt (review/tester stages: reviewer/tester instructions) */
  taskPrompt: string;
  /** IDs of stages that must be 'done' before this one can start */
  dependsOn: string[];
  /**
   * For review stages: list of stage IDs whose completion queues this reviewer.
   * When any of those stages completes, a ReviewQueueItem is added to this stage.
   */
  feedsFromStages: string[];
  status: PipelineStageStatus;
  /** If true, prompt is auto-sent when all deps are satisfied */
  autoSend: boolean;
  /** Controls how session context is managed across rework rounds */
  sessionLifecycle: SessionLifecycle;
  /** What happens after this stage reports Done */
  routingRules: RoutingRule[];
  /** Queue of work items awaiting review (only meaningful for type='review') */
  reviewQueue: ReviewQueueItem[];
  /** Captured at runtime: branch this stage ran on */
  sourceBranch?: string | null;
  /** Captured at runtime: message the agent reported when finishing */
  sourceStatusMessage?: string | null;
  /** Auto-create a git branch when this task stage fires (default: true) */
  autoBranch: boolean;
  /** Branch name prefix for auto-created branches (default: "feature/") */
  autoBranchPrefix: string;
  /** Attached image file paths to send alongside the prompt */
  attachedImages?: { path: string }[];
  /** If true, prompt is wrapped with Ruflo memory_search/memory_store calls */
  useRufloMemory: boolean;
}

// --- Default keywords ---

const DEFAULT_APPROVED_KEYWORDS = ["approved", "lgtm", "looks good", "maestro_status(\"approved\")"];
const DEFAULT_CHANGES_KEYWORDS = ["changes", "fix", "issue", "fail", "CHANGES:"];
const DEFAULT_TESTER_APPROVED_KEYWORDS = ["tests-passed", "passed", "all tests", "maestro_status(\"approved\")"];
const DEFAULT_TESTER_CHANGES_KEYWORDS = ["tests-failed", "failed", "failing", "error", "CHANGES:"];

// --- Helpers ---

function defaultLifecycle(type: StageType): SessionLifecycle {
  if (type === "review" || type === "tester") return "always-fresh";
  if (type === "pr") return "persistent";
  return "fresh-on-rework";
}

function extractFeedback(statusMessage: string): string {
  const match = statusMessage.match(/CHANGES:\s*([\s\S]+)/i);
  return match ? match[1].trim() : statusMessage;
}

/** Collects branch + summary context from all completed dependsOn stages. */
function buildDepContextPreamble(stage: PipelineStage, allStages: PipelineStage[]): string {
  const deps = stage.dependsOn
    .map((id) => allStages.find((s) => s.id === id))
    .filter(
      (s): s is PipelineStage =>
        !!s &&
        (s.status === "done" || s.status === "skipped") &&
        !!(s.sourceBranch || s.sourceStatusMessage)
    );

  if (deps.length === 0) return "";

  const lines = ["**Context from upstream stages:**", ""];
  for (const dep of deps) {
    lines.push(`**${dep.name}**`);
    if (dep.sourceBranch) lines.push(`- Branch: \`${dep.sourceBranch}\``);
    if (dep.sourceStatusMessage) lines.push(`- Summary: ${dep.sourceStatusMessage}`);
    lines.push("");
  }
  return lines.join("\n");
}

/** Wraps a prompt with Ruflo memory_search/memory_store call instructions. */
function wrapWithRufloMemory(stageName: string, promptText: string): string {
  return [
    `Before starting, use the memory_search MCP tool to find relevant patterns:`,
    `  memory_search("${stageName}")`,
    `Apply any relevant patterns to guide your approach.`,
    ``,
    promptText,
    ``,
    `After completing your work, use the memory_store MCP tool to save what worked:`,
    `  memory_store("${stageName}: <concise summary of approach and outcome>")`,
  ].join("\n");
}

/** Generates a git-safe branch name from a stage name and prefix. */
export function generateBranchName(stageName: string, prefix: string): string {
  const slug = stageName
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .trim()
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .substring(0, 40);
  return `${prefix}${slug}`;
}

// --- Store interfaces ---

interface PipelineState {
  stages: PipelineStage[];
  isEnabled: boolean;
  pendingApprovals: HumanApprovalRequest[];
  templates: PipelineTemplate[];
}

interface PipelineActions {
  addStage: (stage: Omit<PipelineStage, "id" | "status">) => void;
  updateStage: (id: string, updates: Partial<Omit<PipelineStage, "id">>) => void;
  removeStage: (id: string) => void;
  reorderStages: (fromIndex: number, toIndex: number) => void;
  /** Called when a session reports Done. Marks the running stage done and triggers next. */
  onSessionDone: (sessionId: number, statusMessage?: string) => void;
  /** Returns stages whose dependsOn are all done and status is pending */
  getReadyStages: () => PipelineStage[];
  getStagesForSession: (sessionId: number) => PipelineStage[];
  /** Manually mark the running stage for a session as done */
  markStageDone: (sessionId: number) => void;
  toggleEnabled: () => void;
  clearAll: () => void;
  loadPreset: (stages: Omit<PipelineStage, "id" | "status">[]) => void;
  saveTemplate: (name: string) => void;
  deleteTemplate: (templateId: string) => void;
  /** Pull the next waiting queue item and send it to the reviewer session */
  processReviewQueue: (reviewerStageId: string) => void;
  /** Build the review prompt sent to a reviewer session */
  buildReviewPrompt: (item: ReviewQueueItem, reviewerStage: PipelineStage) => string;
  /** Build the tester prompt including branch context */
  buildTesterPrompt: (testerStage: PipelineStage) => string;
  /** Build a feedback prompt for a persistent-lifecycle rework (no branch preamble) */
  buildFeedbackPrompt: (feedback: string, sourceStage: PipelineStage) => string;
  /** Build a rework prompt that includes branch context (for fresh-on-rework lifecycle) */
  buildReworkPrompt: (feedback: string, sourceStage: PipelineStage) => string;
  /** Send feedback/rework prompt to the source stage session (using /clear for fresh lifecycles) */
  spawnReworkSession: (sourceStage: PipelineStage, feedback: string) => Promise<void>;
  /** Trigger any pending stages whose dependencies are now all satisfied */
  triggerReadyStages: () => void;
  /** Trigger a specific stage by ID if it's pending and autoSend */
  triggerStage: (stageId: string) => void;
  /** Handle routing after a review stage session reports Done */
  handleReviewerDone: (reviewerStage: PipelineStage, statusMessage: string) => void;
  /** Handle routing after a tester stage session reports Done */
  handleTesterDone: (testerStage: PipelineStage, statusMessage: string) => void;
  /** Approve a human approval request and trigger the next stage */
  approveRequest: (requestId: string) => void;
  /** Reject a human approval request and send feedback to the reviewer */
  rejectRequest: (requestId: string, feedback: string) => void;
}

// --- Tauri LazyStore adapter ---

const lazyStore = new LazyStore("maestro-pipeline.json");

const tauriStorage: StateStorage = {
  getItem: async (name: string): Promise<string | null> => {
    try {
      const value = await lazyStore.get<string>(name);
      return value ?? null;
    } catch (err) {
      console.error(`pipelineStorage.getItem("${name}") failed:`, err);
      return null;
    }
  },
  setItem: async (name: string, value: string): Promise<void> => {
    try {
      await lazyStore.set(name, value);
      await lazyStore.save();
    } catch (err) {
      console.error(`pipelineStorage.setItem("${name}") failed:`, err);
      throw err;
    }
  },
  removeItem: async (name: string): Promise<void> => {
    try {
      await lazyStore.delete(name);
      await lazyStore.save();
    } catch (err) {
      console.error(`pipelineStorage.removeItem("${name}") failed:`, err);
      throw err;
    }
  },
};

// --- Store ---

export const usePipelineStore = create<PipelineState & PipelineActions>()(
  persist(
    (set, get) => ({
      stages: [],
      isEnabled: false,
      pendingApprovals: [],
      templates: [],

      addStage: (stageData) => {
        const type = stageData.type ?? "task";
        const newStage: PipelineStage = {
          id: crypto.randomUUID(),
          status: "pending",
          ...stageData,
          // Apply defaults after spread so missing fields get filled in
          type,
          feedsFromStages: stageData.feedsFromStages ?? [],
          sessionLifecycle: stageData.sessionLifecycle ?? defaultLifecycle(type),
          routingRules: stageData.routingRules ?? [],
          reviewQueue: stageData.reviewQueue ?? [],
          autoBranch: stageData.autoBranch ?? true,
          autoBranchPrefix: stageData.autoBranchPrefix ?? "feature/",
          attachedImages: stageData.attachedImages ?? [],
          useRufloMemory: stageData.useRufloMemory ?? false,
        };
        set((s) => ({ stages: [...s.stages, newStage] }));
      },

      updateStage: (id, updates) => {
        set((s) => ({
          stages: s.stages.map((stage) =>
            stage.id === id ? { ...stage, ...updates } : stage
          ),
        }));
      },

      removeStage: (id) => {
        set((s) => ({
          stages: s.stages.filter((stage) => stage.id !== id),
        }));
      },

      reorderStages: (fromIndex, toIndex) => {
        const stages = [...get().stages];
        const [moved] = stages.splice(fromIndex, 1);
        stages.splice(toIndex, 0, moved);
        set({ stages });
      },

      onSessionDone: (sessionId, statusMessage = "") => {
        const { stages, isEnabled } = get();
        if (!isEnabled) return;

        // Find the running stage for this session
        const doneStage = stages.find(
          (s) => s.sessionId === sessionId && s.status === "running"
        );
        if (!doneStage) return;

        // Mark it done and store the status message
        set((s) => ({
          stages: s.stages.map((stage) =>
            stage.id === doneStage.id
              ? { ...stage, status: "done" as PipelineStageStatus, sourceStatusMessage: statusMessage }
              : stage
          ),
        }));

        // If this is a task/pr stage, check if it feeds any review stages
        if (doneStage.type === "task" || doneStage.type === "pr") {
          const currentStages = get().stages;
          const reviewStages = currentStages.filter(
            (s) =>
              s.type === "review" &&
              (s.feedsFromStages.includes(doneStage.id) ||
                s.dependsOn.includes(doneStage.id))
          );

          for (const reviewStage of reviewStages) {
            const session = useSessionStore.getState().sessions.find(
              (s) => s.id === sessionId
            );
            const queueItem: ReviewQueueItem = {
              id: crypto.randomUUID(),
              sourceStageId: doneStage.id,
              sourceSessionId: sessionId,
              sourceBranch: doneStage.sourceBranch ?? session?.branch ?? null,
              sourceStageName: doneStage.name,
              sourceStatusMessage: statusMessage || null,
              addedAt: Date.now(),
              reviewStatus: "waiting",
            };

            set((s) => ({
              stages: s.stages.map((stage) =>
                stage.id === reviewStage.id
                  ? { ...stage, reviewQueue: [...stage.reviewQueue, queueItem] }
                  : stage
              ),
            }));

            // If the reviewer is not currently running, kick off the queue
            const freshReviewStage = get().stages.find((s) => s.id === reviewStage.id);
            if (freshReviewStage && freshReviewStage.status !== "running") {
              get().processReviewQueue(reviewStage.id);
            }
          }
        }

        // If this is a review stage, handle routing
        if (doneStage.type === "review") {
          get().handleReviewerDone(doneStage, statusMessage);
          return;
        }

        // If this is a tester stage, handle routing
        if (doneStage.type === "tester") {
          get().handleTesterDone(doneStage, statusMessage);
          return;
        }

        // Also check routing rules on the completing stage
        if (doneStage.routingRules.length > 0) {
          const lowerMsg = statusMessage.toLowerCase();
          for (const rule of doneStage.routingRules) {
            const keywords = rule.keywords.length > 0
              ? rule.keywords
              : rule.condition === "approved"
                ? DEFAULT_APPROVED_KEYWORDS
                : DEFAULT_CHANGES_KEYWORDS;
            const matched = keywords.some((kw) => lowerMsg.includes(kw.toLowerCase()));
            if (matched && rule.targetStageId && rule.targetStageId !== "__source__") {
              get().triggerStage(rule.targetStageId);
            }
          }
        }

        // Trigger any stages whose dependsOn is now satisfied
        get().triggerReadyStages();
      },

      handleReviewerDone: (reviewerStage, statusMessage) => {
        // Re-read the latest reviewer stage from store (onSessionDone already marked it done)
        const latestReviewer = get().stages.find((s) => s.id === reviewerStage.id) ?? reviewerStage;

        // Detect result via routing rule keywords
        const approvedRule = latestReviewer.routingRules.find(
          (r) => r.condition === "approved"
        );
        const changesRule = latestReviewer.routingRules.find(
          (r) => r.condition === "changes_needed"
        );

        const approvedKeywords =
          approvedRule && approvedRule.keywords.length > 0
            ? approvedRule.keywords
            : DEFAULT_APPROVED_KEYWORDS;
        const changesKeywords =
          changesRule && changesRule.keywords.length > 0
            ? changesRule.keywords
            : DEFAULT_CHANGES_KEYWORDS;

        const lowerMsg = statusMessage.toLowerCase();
        const isApproved = approvedKeywords.some((kw) =>
          lowerMsg.includes(kw.toLowerCase())
        );
        const isChanges = changesKeywords.some((kw) =>
          lowerMsg.includes(kw.toLowerCase())
        );

        // Find the queue item currently being reviewed
        const reviewingItem = latestReviewer.reviewQueue.find(
          (item) => item.reviewStatus === "reviewing"
        );

        if (reviewingItem) {
          // Mark this queue item done
          set((s) => ({
            stages: s.stages.map((stage) =>
              stage.id === latestReviewer.id
                ? {
                    ...stage,
                    reviewQueue: stage.reviewQueue.map((item) =>
                      item.id === reviewingItem.id
                        ? { ...item, reviewStatus: "done" }
                        : item
                    ),
                  }
                : stage
            ),
          }));

          if (isApproved && approvedRule && approvedRule.targetStageId) {
            // If the approved target is a tester, pass branch context first
            const targetStage = get().stages.find((s) => s.id === approvedRule.targetStageId);
            if (targetStage?.type === "tester") {
              get().updateStage(approvedRule.targetStageId, {
                sourceBranch: reviewingItem.sourceBranch,
                sourceStatusMessage: statusMessage,
              });
            }
            get().triggerStage(approvedRule.targetStageId);
          } else if (isChanges) {
            // Route changes back to source stage
            const sourceStage = get().stages.find(
              (s) => s.id === reviewingItem.sourceStageId
            );
            if (sourceStage) {
              const feedback = extractFeedback(statusMessage);
              get()
                .spawnReworkSession(sourceStage, feedback)
                .catch((err) => {
                  console.error("[Pipeline] spawnReworkSession failed:", err);
                });
            }

            // If changesRule has an explicit non-source target, trigger it too
            if (
              changesRule &&
              changesRule.targetStageId &&
              changesRule.targetStageId !== "__source__"
            ) {
              get().triggerStage(changesRule.targetStageId);
            }
          }
        }

        // Check if there are more waiting items in the queue
        const updatedReviewer = get().stages.find((s) => s.id === latestReviewer.id);
        const hasMoreItems =
          updatedReviewer?.reviewQueue.some((item) => item.reviewStatus === "waiting") ?? false;

        if (hasMoreItems) {
          // Reset review stage to pending so processReviewQueue can pull next item
          set((s) => ({
            stages: s.stages.map((stage) =>
              stage.id === latestReviewer.id
                ? { ...stage, status: "pending" as PipelineStageStatus }
                : stage
            ),
          }));
          get().processReviewQueue(latestReviewer.id);
        }

        // Trigger any stages whose dependsOn is now satisfied
        get().triggerReadyStages();
      },

      handleTesterDone: (testerStage, statusMessage) => {
        const latestTester = get().stages.find((s) => s.id === testerStage.id) ?? testerStage;

        // Check for NEEDS_APPROVAL first (UI change requires human review)
        const needsApprovalMatch = statusMessage.match(/NEEDS_APPROVAL:\s*([\s\S]+)/i);
        if (needsApprovalMatch) {
          const message = needsApprovalMatch[1].trim();
          const approval: HumanApprovalRequest = {
            id: crypto.randomUUID(),
            stageId: latestTester.id,
            stageName: latestTester.name,
            branch: latestTester.sourceBranch ?? null,
            message,
            addedAt: Date.now(),
            status: "pending",
          };
          set((s) => ({ pendingApprovals: [...s.pendingApprovals, approval] }));
          // Do NOT trigger routing — wait for human action
          return;
        }

        // Check for test result keywords via routing rules
        const approvedRule = latestTester.routingRules.find((r) => r.condition === "approved");
        const changesRule = latestTester.routingRules.find((r) => r.condition === "changes_needed");

        const approvedKeywords =
          approvedRule && approvedRule.keywords.length > 0
            ? approvedRule.keywords
            : DEFAULT_TESTER_APPROVED_KEYWORDS;
        const changesKeywords =
          changesRule && changesRule.keywords.length > 0
            ? changesRule.keywords
            : DEFAULT_TESTER_CHANGES_KEYWORDS;

        const lowerMsg = statusMessage.toLowerCase();
        const isApproved = approvedKeywords.some((kw) => lowerMsg.includes(kw.toLowerCase()));
        const isChanges = changesKeywords.some((kw) => lowerMsg.includes(kw.toLowerCase()));

        if (isApproved && approvedRule?.targetStageId) {
          get().triggerStage(approvedRule.targetStageId);
        } else if (isChanges && changesRule?.targetStageId && changesRule.targetStageId !== "__source__") {
          get().triggerStage(changesRule.targetStageId);
        }

        // Trigger any stages whose dependsOn is now satisfied
        get().triggerReadyStages();
      },

      approveRequest: (requestId) => {
        const approval = get().pendingApprovals.find((a) => a.id === requestId);
        if (!approval) return;

        set((s) => ({
          pendingApprovals: s.pendingApprovals.map((a) =>
            a.id === requestId ? { ...a, status: "approved" as const } : a
          ),
        }));

        // Find the tester stage and trigger its approved routing
        const testerStage = get().stages.find((s) => s.id === approval.stageId);
        if (!testerStage) return;

        const approvedRule = testerStage.routingRules.find((r) => r.condition === "approved");
        if (approvedRule?.targetStageId) {
          get().triggerStage(approvedRule.targetStageId);
        }
      },

      rejectRequest: (requestId, feedback) => {
        const approval = get().pendingApprovals.find((a) => a.id === requestId);
        if (!approval) return;

        set((s) => ({
          pendingApprovals: s.pendingApprovals.map((a) =>
            a.id === requestId ? { ...a, status: "rejected" as const } : a
          ),
        }));

        // Find the tester stage and its changes routing (typically back to reviewer)
        const testerStage = get().stages.find((s) => s.id === approval.stageId);
        if (!testerStage) return;

        const changesRule = testerStage.routingRules.find((r) => r.condition === "changes_needed");
        if (!changesRule?.targetStageId || changesRule.targetStageId === "__source__") return;

        const targetStage = get().stages.find((s) => s.id === changesRule.targetStageId);
        if (!targetStage) return;

        const branch = approval.branch;
        const rejectionPrompt = [
          `Human visual review of "${approval.stageName}"${branch ? ` on branch \`${branch}\`` : ""} was rejected.`,
          "",
          "Feedback:",
          feedback,
          "",
          ...(branch
            ? [
                `Please checkout branch \`${branch}\` and review the reported issues before re-approving.`,
                "",
              ]
            : []),
          `When done, call maestro_status("approved") to proceed.`,
        ].join("\n");

        const send = async () => {
          if (targetStage.sessionLifecycle !== "persistent") {
            await sendPromptToSession(targetStage.sessionId, "/clear");
            await new Promise((r) => setTimeout(r, 1500));
          }
          await sendPromptToSession(targetStage.sessionId, rejectionPrompt);
        };

        send().catch((err) => {
          console.error("[Pipeline] rejectRequest send failed:", err);
        });

        set((s) => ({
          stages: s.stages.map((st) =>
            st.id === changesRule.targetStageId
              ? { ...st, status: "running" as PipelineStageStatus }
              : st
          ),
        }));
      },

      processReviewQueue: (reviewerStageId) => {
        const reviewerStage = get().stages.find((s) => s.id === reviewerStageId);
        if (!reviewerStage || reviewerStage.type !== "review") return;
        if (reviewerStage.status === "running") return; // Already busy

        const nextItem = reviewerStage.reviewQueue.find(
          (item) => item.reviewStatus === "waiting"
        );
        if (!nextItem) return; // Queue empty

        const basePrompt = get().buildReviewPrompt(nextItem, reviewerStage);
        const prompt = reviewerStage.useRufloMemory
          ? wrapWithRufloMemory(reviewerStage.name, basePrompt)
          : basePrompt;

        const sendReview = async () => {
          // For always-fresh: send /clear to reset Claude's conversation context
          if (reviewerStage.sessionLifecycle === "always-fresh") {
            await sendPromptToSession(reviewerStage.sessionId, "/clear");
            // Wait for /clear to process
            await new Promise((r) => setTimeout(r, 1500));
          }
          await sendPromptToSession(reviewerStage.sessionId, prompt);
        };

        sendReview().catch((err) => {
          console.error("[Pipeline] processReviewQueue send failed:", err);
        });

        // Mark item as reviewing and stage as running
        set((s) => ({
          stages: s.stages.map((stage) =>
            stage.id === reviewerStageId
              ? {
                  ...stage,
                  status: "running" as PipelineStageStatus,
                  reviewQueue: stage.reviewQueue.map((item) =>
                    item.id === nextItem.id
                      ? { ...item, reviewStatus: "reviewing" }
                      : item
                  ),
                }
              : stage
          ),
        }));
      },

      buildReviewPrompt: (item, reviewerStage) => {
        const lines: string[] = [];

        lines.push(
          `You are reviewing work completed by "${item.sourceStageName}"${
            item.sourceBranch ? ` on branch \`${item.sourceBranch}\`` : ""
          }.`
        );
        lines.push("");

        if (item.sourceStatusMessage) {
          lines.push(`The agent reported: "${item.sourceStatusMessage}"`);
          lines.push("");
        }

        if (item.sourceBranch) {
          lines.push("To understand what changed, run:");
          lines.push(`  git diff main..${item.sourceBranch} --stat`);
          lines.push(`  git diff main..${item.sourceBranch}`);
          lines.push("");
        }

        lines.push(reviewerStage.taskPrompt);
        lines.push("");
        lines.push("After reviewing, end your response by calling:");
        lines.push(
          `  maestro_status("approved")                         — if the work is ready to merge`
        );
        lines.push(
          `  maestro_status("CHANGES: <your detailed feedback>")  — if changes are needed`
        );

        return lines.join("\n").trim();
      },

      buildTesterPrompt: (testerStage) => {
        const lines: string[] = [];
        const branch = testerStage.sourceBranch;

        if (branch) {
          lines.push(`You are testing the work done on branch \`${branch}\`.`);
          lines.push("");
          lines.push("First, switch to the branch:");
          lines.push(`  git checkout ${branch}`);
          lines.push("");
          if (testerStage.sourceStatusMessage) {
            lines.push(`The reviewer approved this work: "${testerStage.sourceStatusMessage}"`);
            lines.push("");
          }
        }

        lines.push(testerStage.taskPrompt);
        lines.push("");
        lines.push("After testing, end your response by calling:");
        lines.push(
          `  maestro_status("tests-passed - <summary>")         — if all tests pass`
        );
        lines.push(
          `  maestro_status("tests-failed: <failure details>")  — if tests fail`
        );
        lines.push(
          `  maestro_status("NEEDS_APPROVAL: <what to check>")  — if UI changes need human review`
        );

        return lines.join("\n").trim();
      },

      buildFeedbackPrompt: (feedback, sourceStage) => {
        return [
          `The code reviewer has reviewed your work on "${sourceStage.name}" and requested changes:`,
          "",
          "---",
          feedback,
          "---",
          "",
          "Please address all the feedback above and complete the changes.",
          `When done, call maestro_status("finished") with a summary of what you changed.`,
        ].join("\n");
      },

      buildReworkPrompt: (feedback, sourceStage) => {
        const session = useSessionStore
          .getState()
          .sessions.find((s) => s.id === sourceStage.sessionId);
        const branch = sourceStage.sourceBranch ?? session?.branch ?? null;

        if (branch && sourceStage.sessionLifecycle === "fresh-on-rework") {
          return [
            `You are working on branch \`${branch}\`.`,
            `Run: git diff main..${branch} --stat   ← see what was already done`,
            `Run: git diff main..${branch}          ← review the exact changes`,
            "",
            `The code reviewer has reviewed the work on "${sourceStage.name}" and requested changes:`,
            "",
            "---",
            feedback,
            "---",
            "",
            "Address all the feedback above and complete the changes.",
            `When done, call maestro_status("finished") with a summary of what you changed.`,
          ].join("\n");
        }

        return get().buildFeedbackPrompt(feedback, sourceStage);
      },

      spawnReworkSession: async (sourceStage, feedback) => {
        const reworkPrompt = get().buildReworkPrompt(feedback, sourceStage);

        // Mark source stage as running (receiving feedback)
        set((s) => ({
          stages: s.stages.map((stage) =>
            stage.id === sourceStage.id
              ? { ...stage, status: "running" as PipelineStageStatus }
              : stage
          ),
        }));

        // For non-persistent lifecycles: send /clear first to reset Claude's context
        // This achieves the "fresh session" token efficiency without needing a new PTY
        if (sourceStage.sessionLifecycle !== "persistent") {
          await sendPromptToSession(sourceStage.sessionId, "/clear");
          // Wait for /clear to complete
          await new Promise((r) => setTimeout(r, 1500));
        }

        // Send the rework prompt
        await sendPromptToSession(sourceStage.sessionId, reworkPrompt);
      },

      triggerReadyStages: () => {
        const { stages } = get();
        const readyStages = stages.filter((stage) => {
          if (stage.status !== "pending") return false;
          return stage.dependsOn.every((depId) => {
            const dep = stages.find((s) => s.id === depId);
            return dep?.status === "done" || dep?.status === "skipped";
          });
        });

        for (const stage of readyStages) {
          if (!stage.autoSend) continue;

          // Feature D: Manual session detection — skip if session is already busy
          const sessionState = useSessionStore
            .getState()
            .sessions.find((s) => s.id === stage.sessionId);
          if (sessionState?.status === "Working" || sessionState?.status === "NeedsInput") {
            console.log(
              `[Pipeline] Session ${stage.sessionId} is busy — skipping auto-send for "${stage.name}"`
            );
            continue;
          }

          const capturedStage = stage;
          const send = async () => {
            let promptText = capturedStage.taskPrompt;

            // Feature B: Auto-branch creation for task stages
            if (capturedStage.autoBranch && capturedStage.type === "task") {
              const branch = generateBranchName(
                capturedStage.name,
                capturedStage.autoBranchPrefix
              );
              get().updateStage(capturedStage.id, { sourceBranch: branch });
              promptText = [
                `First, create a new git branch for this work:`,
                `  git checkout -b ${branch}`,
                ``,
                `Then:`,
                capturedStage.taskPrompt,
              ].join("\n");
            } else if (capturedStage.type === "tester") {
              // Re-read stage after updateStage calls above
              const freshStage =
                get().stages.find((s) => s.id === capturedStage.id) ?? capturedStage;
              promptText = get().buildTesterPrompt(freshStage);
            }

            // Inject upstream context for task/pr stages with dependsOn
            if (capturedStage.type === "task" || capturedStage.type === "pr") {
              const depContext = buildDepContextPreamble(capturedStage, get().stages);
              if (depContext) {
                promptText = `${depContext}\n\n${promptText}`;
              }
            }

            // Feature C: Prepend image file paths (Claude Code reads them as attachments)
            const imagePaths = (capturedStage.attachedImages ?? [])
              .map((img) => img.path)
              .join(" ");
            const fullPrompt = imagePaths ? `${imagePaths} ${promptText}` : promptText;

            const fullPromptWithMemory = capturedStage.useRufloMemory
              ? wrapWithRufloMemory(capturedStage.name, fullPrompt)
              : fullPrompt;
            await sendPromptToSession(capturedStage.sessionId, fullPromptWithMemory);
          };

          send().catch((err) => {
            console.error(
              `[Pipeline] Failed to auto-send task to session ${stage.sessionId}:`,
              err
            );
          });

          set((s) => ({
            stages: s.stages.map((st) =>
              st.id === stage.id ? { ...st, status: "running" } : st
            ),
          }));
        }
      },

      triggerStage: (stageId) => {
        const stage = get().stages.find((s) => s.id === stageId);
        if (!stage || stage.status !== "pending") return;
        if (!stage.autoSend) return;

        // Feature D: Manual session detection — skip if session is already busy
        const sessionState = useSessionStore
          .getState()
          .sessions.find((s) => s.id === stage.sessionId);
        if (sessionState?.status === "Working" || sessionState?.status === "NeedsInput") {
          console.log(
            `[Pipeline] Session ${stage.sessionId} is busy — skipping auto-send for "${stage.name}"`
          );
          return;
        }

        const send = async () => {
          let promptText = stage.taskPrompt;

          // Feature B: Auto-branch creation for task stages
          if (stage.autoBranch && stage.type === "task") {
            const branch = generateBranchName(stage.name, stage.autoBranchPrefix);
            get().updateStage(stage.id, { sourceBranch: branch });
            promptText = [
              `First, create a new git branch for this work:`,
              `  git checkout -b ${branch}`,
              ``,
              `Then:`,
              stage.taskPrompt,
            ].join("\n");
          } else if (stage.type === "tester") {
            // Re-read stage after any updateStage calls
            const freshStage = get().stages.find((s) => s.id === stage.id) ?? stage;
            promptText = get().buildTesterPrompt(freshStage);
          }

          // Inject upstream context for task/pr stages with dependsOn
          if (stage.type === "task" || stage.type === "pr") {
            const depContext = buildDepContextPreamble(stage, get().stages);
            if (depContext) {
              promptText = `${depContext}\n\n${promptText}`;
            }
          }

          // Feature C: Prepend image file paths (Claude Code reads them as attachments)
          const imagePaths = (stage.attachedImages ?? []).map((img) => img.path).join(" ");
          const fullPrompt = imagePaths ? `${imagePaths} ${promptText}` : promptText;

          const fullPromptWithMemory = stage.useRufloMemory
            ? wrapWithRufloMemory(stage.name, fullPrompt)
            : fullPrompt;
          await sendPromptToSession(stage.sessionId, fullPromptWithMemory);
        };

        send().catch((err) => {
          console.error(`[Pipeline] Failed to trigger stage ${stageId}:`, err);
        });

        set((s) => ({
          stages: s.stages.map((st) =>
            st.id === stageId ? { ...st, status: "running" } : st
          ),
        }));
      },

      getReadyStages: () => {
        const { stages } = get();
        return stages.filter((stage) => {
          if (stage.status !== "pending") return false;
          return stage.dependsOn.every((depId) => {
            const dep = stages.find((s) => s.id === depId);
            return dep?.status === "done" || dep?.status === "skipped";
          });
        });
      },

      getStagesForSession: (sessionId) => {
        return get().stages.filter((s) => s.sessionId === sessionId);
      },

      markStageDone: (sessionId) => {
        get().onSessionDone(sessionId, "");
      },

      toggleEnabled: () => {
        set((s) => ({ isEnabled: !s.isEnabled }));
      },

      clearAll: () => {
        set({ stages: [] });
      },

      saveTemplate: (name) => {
        const templateStages = get().stages.map(
          ({ id, status, sourceBranch, sourceStatusMessage, reviewQueue, ...rest }) =>
            ({ ...rest, reviewQueue: [] })
        );
        set((s) => ({
          templates: [
            ...s.templates,
            {
              id: crypto.randomUUID(),
              name: name.trim(),
              createdAt: Date.now(),
              stages: templateStages,
            },
          ],
        }));
      },

      deleteTemplate: (templateId) =>
        set((s) => ({ templates: s.templates.filter((t) => t.id !== templateId) })),

      loadPreset: (stagesData) => {
        const stages: PipelineStage[] = stagesData.map((data) => {
          const type = data.type ?? "task";
          return {
            id: crypto.randomUUID(),
            status: "pending",
            ...data,
            type,
            feedsFromStages: data.feedsFromStages ?? [],
            sessionLifecycle: data.sessionLifecycle ?? defaultLifecycle(type),
            routingRules: data.routingRules ?? [],
            reviewQueue: data.reviewQueue ?? [],
            autoBranch: data.autoBranch ?? true,
            autoBranchPrefix: data.autoBranchPrefix ?? "feature/",
            attachedImages: data.attachedImages ?? [],
            useRufloMemory: data.useRufloMemory ?? false,
          };
        });
        set({ stages });
      },
    }),
    {
      name: "maestro-pipeline",
      storage: createJSONStorage(() => tauriStorage),
      partialize: (state) => ({
        stages: state.stages,
        isEnabled: state.isEnabled,
        pendingApprovals: state.pendingApprovals,
        templates: state.templates,
      }),
      onRehydrateStorage: () => (state) => {
        // Migrate existing stages to include new fields with defaults
        if (state) {
          state.stages = state.stages.map((s) => {
            const type: StageType = (s.type as StageType) ?? "task";
            return {
              ...s,
              type,
              feedsFromStages: s.feedsFromStages ?? [],
              sessionLifecycle: s.sessionLifecycle ?? defaultLifecycle(type),
              routingRules: s.routingRules ?? [],
              reviewQueue: s.reviewQueue ?? [],
              autoBranch: s.autoBranch ?? true,
              autoBranchPrefix: s.autoBranchPrefix ?? "feature/",
              attachedImages: s.attachedImages ?? [],
              useRufloMemory: s.useRufloMemory ?? false,
            };
          });
          state.pendingApprovals = state.pendingApprovals ?? [];
          state.templates = state.templates ?? [];
        }
      },
    }
  )
);
