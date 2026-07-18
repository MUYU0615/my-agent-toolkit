export type PlatformUserStatus = "active" | "disabled";
export type PersonalAgentStatus = "ready" | "disabled";
export type UserAgentBindingType = "personal";
export type WorkStatus = "draft" | "active" | "waiting" | "completed" | "failed" | "cancelled";
export type WorkPriority = "low" | "normal" | "high" | "urgent";
export type WorkStageStatus =
  | "pending"
  | "queued"
  | "running"
  | "waiting_user"
  | "revision_required"
  | "succeeded"
  | "failed"
  | "cancelled";
export type WorkEventActorType = "user" | "agent" | "system";
export type WorkConversationStatus = "active" | "closed";
export type WorkRuntimeSessionStatus = "created" | "active" | "released" | "failed";
export type ArtifactVisibility = "work" | "stage" | "private";
export type ExecutionQueueStatus = "queued" | "leased" | "completed" | "failed" | "cancelled";
export type ExecutionRunStatus = "running" | "succeeded" | "failed" | "cancelled";
export type GateKind = "rule" | "agent_review" | "human_review";
export type GateOutcome = "passed" | "revision_required" | "human_required" | "failed";
export type HandoffStatus = "completed";

export interface PlatformUserRecord {
  user_id: string;
  wecom_user_id: string;
  display_name: string;
  status: PlatformUserStatus;
  created_at: string;
  updated_at: string;
}

export interface CreatePlatformUserInput {
  user_id?: string;
  wecom_user_id: string;
  display_name: string;
  status?: PlatformUserStatus;
}

export interface PersonalAgentRecord {
  agent_id: string;
  name: string;
  runtime: string;
  status: PersonalAgentStatus;
  created_at: string;
  updated_at: string;
}

export interface CreatePersonalAgentInput {
  agent_id?: string;
  name: string;
  runtime: string;
  status?: PersonalAgentStatus;
}

export interface UserAgentBindingRecord {
  binding_id: string;
  user_id: string;
  agent_id: string;
  binding_type: UserAgentBindingType;
  created_at: string;
}

export interface BindUserAgentInput {
  user_id: string;
  agent_id: string;
  binding_type?: UserAgentBindingType;
}

export interface AgentBotBindingRecord {
  binding_id: string;
  agent_id: string;
  bot_id: string;
  created_at: string;
}

export interface BindAgentBotInput {
  agent_id: string;
  bot_id: string;
}

export interface WorkItemRecord {
  work_id: string;
  title: string;
  description?: string;
  created_by_user_id: string;
  assigned_user_id?: string;
  assigned_agent_id?: string;
  current_stage_id?: string;
  status: WorkStatus;
  priority: WorkPriority;
  created_at: string;
  updated_at: string;
}

export interface CreateWorkItemInput {
  work_id?: string;
  title: string;
  description?: string;
  created_by_user_id: string;
  assigned_user_id?: string;
  assigned_agent_id?: string;
  priority?: WorkPriority;
}

export interface ListWorkItemsInput {
  created_by_user_id?: string;
  assigned_user_id?: string;
  assigned_agent_id?: string;
  status?: WorkStatus;
}

export interface WorkStageRecord {
  stage_id: string;
  work_id: string;
  name: string;
  intent: string;
  position: number;
  assigned_user_id?: string;
  assigned_agent_id?: string;
  conversation_id?: string;
  workspace_ref?: string;
  status: WorkStageStatus;
  created_at: string;
  updated_at: string;
}

export interface CreateWorkStageInput {
  stage_id?: string;
  work_id: string;
  name: string;
  intent: string;
  assigned_user_id?: string;
  assigned_agent_id?: string;
  status?: Extract<WorkStageStatus, "pending" | "queued">;
  actor_type?: WorkEventActorType;
  actor_id?: string;
}

export interface WorkConversationRecord {
  conversation_id: string;
  work_id: string;
  stage_id: string;
  assigned_user_id?: string;
  assigned_agent_id?: string;
  status: WorkConversationStatus;
  created_at: string;
  updated_at: string;
}

export interface WorkRuntimeSessionRecord {
  runtime_session_id: string;
  work_id: string;
  stage_id: string;
  conversation_id: string;
  agent_id: string;
  runtime: string;
  provider_session_id?: string;
  workspace_ref: string;
  status: WorkRuntimeSessionStatus;
  created_at: string;
  updated_at: string;
}

export interface CreateWorkRuntimeSessionInput {
  stage_id: string;
  agent_id: string;
  runtime: string;
  provider_session_id?: string;
  status?: Extract<WorkRuntimeSessionStatus, "created" | "active">;
}

export interface ArtifactRecord {
  artifact_id: string;
  work_id: string;
  stage_id: string;
  artifact_type: string;
  title: string;
  visibility: ArtifactVisibility;
  created_by_type: WorkEventActorType;
  created_by_id?: string;
  latest_version: number;
  created_at: string;
  updated_at: string;
}

export interface ArtifactVersionRecord {
  artifact_version_id: string;
  artifact_id: string;
  work_id: string;
  stage_id: string;
  version: number;
  content_ref: string;
  mime_type: string;
  integrity_sha256: string;
  summary: string;
  created_by_type: WorkEventActorType;
  created_by_id?: string;
  created_at: string;
}

export interface CreateArtifactInput {
  artifact_id?: string;
  stage_id: string;
  artifact_type: string;
  title: string;
  visibility?: ArtifactVisibility;
  content_ref: string;
  mime_type?: string;
  integrity_sha256: string;
  summary: string;
  created_by_type: WorkEventActorType;
  created_by_id?: string;
}

export interface PublishArtifactVersionInput {
  content_ref: string;
  mime_type?: string;
  integrity_sha256: string;
  summary: string;
  created_by_type: WorkEventActorType;
  created_by_id?: string;
}

export interface ExecutionQueueRecord {
  queue_id: string;
  work_id: string;
  stage_id: string;
  user_id: string;
  agent_id: string;
  bot_id: string;
  runtime: string;
  conversation_id: string;
  workspace_ref: string;
  prompt_snapshot: string;
  idempotency_key: string;
  status: ExecutionQueueStatus;
  attempt: number;
  available_at: string;
  leased_by?: string;
  lease_expires_at?: string;
  created_at: string;
  updated_at: string;
}

export interface ExecutionRunRecord {
  execution_id: string;
  queue_id: string;
  work_id: string;
  stage_id: string;
  agent_id: string;
  runtime_session_id?: string;
  runner_session_id?: string;
  worker_id: string;
  attempt: number;
  status: ExecutionRunStatus;
  output?: string;
  error_code?: string;
  error_message?: string;
  started_at: string;
  finished_at?: string;
  updated_at: string;
}

export interface EnqueueWorkStageInput {
  stage_id: string;
  actor_id?: string;
  idempotency_key?: string;
}

export interface LeaseExecutionInput {
  worker_id: string;
  lease_seconds?: number;
}

export interface LeasedExecution {
  queue_item: ExecutionQueueRecord;
  execution: ExecutionRunRecord;
  runtime_request: {
    bot_id: string;
    user_id: string;
    conversation_id: string;
    runtime: string;
    prompt: string;
  };
}

export interface CompleteExecutionInput {
  status: Extract<ExecutionRunStatus, "succeeded" | "failed" | "cancelled">;
  runner_session_id?: string;
  output?: string;
  error_code?: string;
  error_message?: string;
}

export interface GateDefinitionRecord {
  gate_id: string;
  work_id: string;
  stage_id: string;
  name: string;
  kind: GateKind;
  criteria: string;
  reviewer_user_id?: string;
  reviewer_agent_id?: string;
  created_at: string;
}

export interface CreateGateDefinitionInput {
  gate_id?: string;
  stage_id: string;
  name: string;
  kind: GateKind;
  criteria: string;
  reviewer_user_id?: string;
  reviewer_agent_id?: string;
  actor_id?: string;
}

export interface GateResultRecord {
  gate_result_id: string;
  gate_id: string;
  work_id: string;
  stage_id: string;
  artifact_version_id: string;
  outcome: GateOutcome;
  evidence: string;
  blocking_rule?: string;
  responsible_user_id?: string;
  minimum_changes?: string;
  actor_type: WorkEventActorType;
  actor_id?: string;
  created_at: string;
}

export interface CreateGateResultInput {
  gate_id: string;
  artifact_version_id: string;
  outcome: GateOutcome;
  evidence: string;
  blocking_rule?: string;
  responsible_user_id?: string;
  minimum_changes?: string;
  actor_type: WorkEventActorType;
  actor_id?: string;
}

export interface HandoffArtifactSnapshot {
  artifact_id: string;
  artifact_version_id: string;
  artifact_type: string;
  title: string;
  version: number;
  content_ref: string;
  integrity_sha256: string;
  summary: string;
}

export interface HandoffContextSnapshot {
  work_goal: string;
  current_stage_goal: string;
  approved_artifacts: HandoffArtifactSnapshot[];
  acceptance_criteria: string;
  key_decisions?: string;
  constraints?: string;
  known_risks?: string;
  open_questions?: string;
  source_evidence_refs: string[];
  expected_output: string;
}

export interface HandoffRecord {
  handoff_id: string;
  work_id: string;
  source_stage_id: string;
  target_stage_id: string;
  gate_result_id: string;
  target_user_id: string;
  target_agent_id: string;
  context_snapshot: HandoffContextSnapshot;
  status: HandoffStatus;
  created_by_user_id: string;
  created_at: string;
}

export interface CreateHandoffInput {
  handoff_id?: string;
  work_id: string;
  source_stage_id: string;
  gate_result_id: string;
  target_user_id: string;
  target_agent_id: string;
  target_stage_name: string;
  target_stage_intent: string;
  acceptance_criteria: string;
  key_decisions?: string;
  constraints?: string;
  known_risks?: string;
  open_questions?: string;
  expected_output: string;
  created_by_user_id: string;
}

export interface CompletedHandoff {
  handoff: HandoffRecord;
  stage: WorkStageRecord;
  queue_item: ExecutionQueueRecord;
}

export interface TransitionWorkStageInput {
  status: WorkStageStatus;
  actor_type: WorkEventActorType;
  actor_id?: string;
  summary?: string;
}

export interface WorkEventRecord {
  event_id: string;
  work_id: string;
  stage_id?: string;
  event_type: string;
  actor_type: WorkEventActorType;
  actor_id?: string;
  summary: string;
  created_at: string;
}

export interface AppendWorkEventInput {
  work_id: string;
  stage_id?: string;
  event_type: string;
  actor_type: WorkEventActorType;
  actor_id?: string;
  summary: string;
}

const STAGE_TRANSITIONS: Record<WorkStageStatus, ReadonlySet<WorkStageStatus>> = {
  pending: new Set(["queued", "cancelled"]),
  queued: new Set(["running", "cancelled"]),
  running: new Set(["waiting_user", "revision_required", "succeeded", "failed", "cancelled"]),
  waiting_user: new Set(["queued", "cancelled"]),
  revision_required: new Set(["queued", "cancelled"]),
  succeeded: new Set(["waiting_user", "revision_required", "failed"]),
  failed: new Set(["queued", "cancelled"]),
  cancelled: new Set(),
};

export function requirePlatformUserStatus(value: string): PlatformUserStatus {
  if (value !== "active" && value !== "disabled") throw new Error("user status is invalid");
  return value;
}

export function requirePersonalAgentStatus(value: string): PersonalAgentStatus {
  if (value !== "ready" && value !== "disabled") throw new Error("agent status is invalid");
  return value;
}

export function requireUserAgentBindingType(value: string): UserAgentBindingType {
  if (value !== "personal") throw new Error("binding_type is invalid");
  return value;
}

export function requireWorkStatus(value: string): WorkStatus {
  if (!["draft", "active", "waiting", "completed", "failed", "cancelled"].includes(value)) {
    throw new Error("work status is invalid");
  }
  return value as WorkStatus;
}

export function requireWorkPriority(value: string): WorkPriority {
  if (!["low", "normal", "high", "urgent"].includes(value)) throw new Error("work priority is invalid");
  return value as WorkPriority;
}

export function requireWorkStageStatus(value: string): WorkStageStatus {
  if (![
    "pending",
    "queued",
    "running",
    "waiting_user",
    "revision_required",
    "succeeded",
    "failed",
    "cancelled",
  ].includes(value)) {
    throw new Error("stage status is invalid");
  }
  return value as WorkStageStatus;
}

export function requireWorkEventActorType(value: string): WorkEventActorType {
  if (value !== "user" && value !== "agent" && value !== "system") {
    throw new Error("actor_type is invalid");
  }
  return value;
}

export function requireWorkRuntimeSessionStatus(value: string): WorkRuntimeSessionStatus {
  if (!["created", "active", "released", "failed"].includes(value)) {
    throw new Error("runtime session status is invalid");
  }
  return value as WorkRuntimeSessionStatus;
}

export function requireArtifactVisibility(value: string): ArtifactVisibility {
  if (value !== "work" && value !== "stage" && value !== "private") {
    throw new Error("artifact visibility is invalid");
  }
  return value;
}

export function requireExecutionQueueStatus(value: string): ExecutionQueueStatus {
  if (!["queued", "leased", "completed", "failed", "cancelled"].includes(value)) {
    throw new Error("execution queue status is invalid");
  }
  return value as ExecutionQueueStatus;
}

export function requireExecutionRunStatus(value: string): ExecutionRunStatus {
  if (!["running", "succeeded", "failed", "cancelled"].includes(value)) {
    throw new Error("execution run status is invalid");
  }
  return value as ExecutionRunStatus;
}

export function requireGateKind(value: string): GateKind {
  if (!["rule", "agent_review", "human_review"].includes(value)) throw new Error("gate kind is invalid");
  return value as GateKind;
}

export function requireGateOutcome(value: string): GateOutcome {
  if (!["passed", "revision_required", "human_required", "failed"].includes(value)) {
    throw new Error("gate outcome is invalid");
  }
  return value as GateOutcome;
}

export function requireSha256(value: string): string {
  const normalized = value.trim().toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(normalized)) throw new Error("integrity_sha256 is invalid");
  return normalized;
}

export function requireWorkspaceRelativeRef(value: string): string {
  const normalized = value.trim().replace(/\\/g, "/");
  if (
    !normalized ||
    normalized.startsWith("/") ||
    normalized.includes("\0") ||
    normalized.split("/").some((part) => part === "" || part === "." || part === "..")
  ) {
    throw new Error("content_ref is invalid");
  }
  return requireLatticeText(normalized, "content_ref", 1_000);
}

export function requireLatticeId(value: string, field: string): string {
  const normalized = value.trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(normalized)) {
    throw new Error(`${field} is invalid`);
  }
  return normalized;
}

export function requireLatticeText(value: string, field: string, maxLength = 500): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`${field} is required`);
  if (normalized.length > maxLength || normalized.includes("\0")) throw new Error(`${field} is invalid`);
  return normalized;
}

export function optionalLatticeText(
  value: string | undefined,
  field: string,
  maxLength = 4_000,
): string | undefined {
  if (value === undefined || value.trim() === "") return undefined;
  return requireLatticeText(value, field, maxLength);
}

export function assertWorkStageTransition(from: WorkStageStatus, to: WorkStageStatus): void {
  if (from === to) return;
  if (!STAGE_TRANSITIONS[from].has(to)) throw new Error(`invalid stage transition: ${from} -> ${to}`);
}

export function workStatusForStage(status: WorkStageStatus): WorkStatus {
  if (status === "waiting_user" || status === "revision_required") return "waiting";
  if (status === "succeeded") return "completed";
  if (status === "failed") return "failed";
  if (status === "cancelled") return "cancelled";
  return "active";
}
