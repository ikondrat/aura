import { randomUUID } from "node:crypto";
import type { Pool, QueryResultRow } from "pg";

export type OnboardingStep = "goal" | "language" | "working_style" | "sources" | "prohibited_actions" | "preview";
export type OnboardingDraftStatus = "in_progress" | "paused" | "ready_for_preview" | "completed" | "cancelled";
export type OnboardingAnswerValue = string | string[];

export interface OnboardingDraft {
  id: string;
  userId: string;
  goal?: string;
  language?: string;
  workingStyle?: string;
  sources: string[];
  prohibitedActions: string[];
  currentStep: OnboardingStep;
  status: OnboardingDraftStatus;
  createdAt: Date;
  updatedAt: Date;
}

export interface OnboardingDraftMutation {
  draft: OnboardingDraft;
  changed: boolean;
}

export interface UpdateOnboardingAnswerInput {
  userId: string;
  draftId: string;
  step: Exclude<OnboardingStep, "preview">;
  value: OnboardingAnswerValue;
}

interface OnboardingDraftRow extends QueryResultRow {
  id: string;
  user_id: string;
  goal: string | null;
  language: string | null;
  working_style: string | null;
  sources: string[];
  prohibited_actions: string[];
  current_step: OnboardingStep;
  status: OnboardingDraftStatus;
  created_at: Date;
  updated_at: Date;
}

type Queryable = Pick<Pool, "query">;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_TEXT_LENGTH = 2_000;
const MAX_LIST_LENGTH = 50;
const MAX_LIST_ITEM_LENGTH = 500;
const DRAFT_COLUMNS =
  "id, user_id, goal, language, working_style, sources, prohibited_actions, current_step, status, created_at, updated_at";
const ACTIVE_STATUSES = ["in_progress", "paused", "ready_for_preview"] as const;

const ANSWER_COLUMNS: Record<Exclude<OnboardingStep, "preview">, string> = {
  goal: "goal",
  language: "language",
  working_style: "working_style",
  sources: "sources",
  prohibited_actions: "prohibited_actions",
};

const NEXT_STEP: Record<Exclude<OnboardingStep, "preview">, OnboardingStep> = {
  goal: "language",
  language: "working_style",
  working_style: "sources",
  sources: "prohibited_actions",
  prohibited_actions: "preview",
};

function requireUuid(value: string, fieldName: string): string {
  if (typeof value !== "string" || !UUID_PATTERN.test(value.trim())) {
    throw new Error(`${fieldName} must be a UUID`);
  }
  return value.trim();
}

function requireText(value: string, fieldName: string, maxLength = MAX_TEXT_LENGTH): string {
  if (typeof value !== "string") throw new Error(`${fieldName} must be a string`);
  const normalized = value.trim();
  if (!normalized) throw new Error(`${fieldName} must not be empty`);
  if (normalized.length > maxLength) throw new Error(`${fieldName} is too long`);
  return normalized;
}

function requireList(value: string[], fieldName: string): string[] {
  if (!Array.isArray(value)) throw new Error(`${fieldName} must be an array`);
  if (value.length > MAX_LIST_LENGTH) throw new Error(`${fieldName} has too many entries`);
  return value.map((entry, index) => requireText(entry, `${fieldName}[${index}]`, MAX_LIST_ITEM_LENGTH));
}

function normalizeAnswer(step: Exclude<OnboardingStep, "preview">, value: OnboardingAnswerValue): string | string[] {
  if (step === "sources" || step === "prohibited_actions") {
    return requireList(value as string[], step);
  }
  return requireText(value as string, step);
}

function mapDraft(row: OnboardingDraftRow): OnboardingDraft {
  return {
    id: row.id,
    userId: row.user_id,
    ...(row.goal === null ? {} : { goal: row.goal }),
    ...(row.language === null ? {} : { language: row.language }),
    ...(row.working_style === null ? {} : { workingStyle: row.working_style }),
    sources: [...row.sources],
    prohibitedActions: [...row.prohibited_actions],
    currentStep: row.current_step,
    status: row.status,
    createdAt: new Date(row.created_at),
    updatedAt: new Date(row.updated_at),
  };
}

export class OnboardingDraftRepository {
  constructor(private readonly db: Queryable) {}

  /** Creates a draft, or returns the user's existing non-terminal draft. */
  async createOrGetActive(userId: string): Promise<{ draft: OnboardingDraft; created: boolean }> {
    const ownerId = requireUuid(userId, "userId");
    const inserted = await this.db.query<OnboardingDraftRow>(
      `INSERT INTO onboarding_drafts (id, user_id)
       VALUES ($1, $2)
       ON CONFLICT (user_id) WHERE status IN ('in_progress', 'paused', 'ready_for_preview') DO NOTHING
       RETURNING ${DRAFT_COLUMNS}`,
      [randomUUID(), ownerId],
    );
    if (inserted.rows[0]) return { draft: mapDraft(inserted.rows[0]), created: true };

    const existing = await this.getActive(ownerId);
    if (!existing) throw new Error("active onboarding draft could not be resolved");
    return { draft: existing, created: false };
  }

  async get(userId: string, draftId: string): Promise<OnboardingDraft | undefined> {
    const ownerId = requireUuid(userId, "userId");
    const id = requireUuid(draftId, "draftId");
    const result = await this.db.query<OnboardingDraftRow>(
      `SELECT ${DRAFT_COLUMNS}
       FROM onboarding_drafts
       WHERE id = $1 AND user_id = $2`,
      [id, ownerId],
    );
    return result.rows[0] ? mapDraft(result.rows[0]) : undefined;
  }

  async getActive(userId: string): Promise<OnboardingDraft | undefined> {
    const ownerId = requireUuid(userId, "userId");
    const result = await this.db.query<OnboardingDraftRow>(
      `SELECT ${DRAFT_COLUMNS}
       FROM onboarding_drafts
       WHERE user_id = $1 AND status IN ('in_progress', 'paused', 'ready_for_preview')
       ORDER BY updated_at DESC, id DESC
       LIMIT 1`,
      [ownerId],
    );
    return result.rows[0] ? mapDraft(result.rows[0]) : undefined;
  }

  /** Advances exactly one questionnaire step. A stale retry cannot advance a second step. */
  async updateAnswer(input: UpdateOnboardingAnswerInput): Promise<OnboardingDraft> {
    const ownerId = requireUuid(input.userId, "userId");
    const draftId = requireUuid(input.draftId, "draftId");
    const column = ANSWER_COLUMNS[input.step];
    const nextStep = NEXT_STEP[input.step];
    const answer = normalizeAnswer(input.step, input.value);
    const nextStatus: OnboardingDraftStatus = nextStep === "preview" ? "ready_for_preview" : "in_progress";
    const result = await this.db.query<OnboardingDraftRow>(
      `UPDATE onboarding_drafts
       SET ${column} = $4, current_step = $5, status = $6
       WHERE id = $1 AND user_id = $2 AND current_step = $3 AND status = 'in_progress'
       RETURNING ${DRAFT_COLUMNS}`,
      [draftId, ownerId, input.step, answer, nextStep, nextStatus],
    );
    if (result.rows[0]) return mapDraft(result.rows[0]);

    const existing = await this.get(ownerId, draftId);
    if (!existing) throw new Error("onboarding draft not found for user");
    throw new Error(`onboarding draft is not accepting the ${input.step} answer (current step: ${existing.currentStep})`);
  }

  async pause(userId: string, draftId: string): Promise<OnboardingDraftMutation> {
    return this.changeStatus(userId, draftId, "in_progress", "paused", "pause", "paused");
  }

  async resume(userId: string, draftId: string): Promise<OnboardingDraftMutation> {
    return this.changeStatus(userId, draftId, "paused", "in_progress", "resume", "in_progress");
  }

  /** Changes only the draft state; callers activating an agent must use the same transaction. */
  async complete(userId: string, draftId: string): Promise<OnboardingDraftMutation> {
    return this.changeStatus(userId, draftId, "ready_for_preview", "completed", "complete", "completed");
  }

  async cancel(userId: string, draftId: string): Promise<OnboardingDraftMutation> {
    return this.changeStatus(
      userId,
      draftId,
      ["in_progress", "paused", "ready_for_preview"],
      "cancelled",
      "cancel",
      "cancelled",
    );
  }

  private async changeStatus(
    userId: string,
    draftId: string,
    expectedStatus: OnboardingDraftStatus | OnboardingDraftStatus[],
    nextStatus: OnboardingDraftStatus,
    operation: string,
    idempotentStatus?: OnboardingDraftStatus,
  ): Promise<OnboardingDraftMutation> {
    const ownerId = requireUuid(userId, "userId");
    const id = requireUuid(draftId, "draftId");
    const expectedStatuses = Array.isArray(expectedStatus) ? expectedStatus : [expectedStatus];
    const result = await this.db.query<OnboardingDraftRow>(
      `UPDATE onboarding_drafts
       SET status = $3
       WHERE id = $1 AND user_id = $2 AND status = ANY($4::text[])
       RETURNING ${DRAFT_COLUMNS}`,
      [id, ownerId, nextStatus, expectedStatuses],
    );
    if (result.rows[0]) return { draft: mapDraft(result.rows[0]), changed: true };

    const existing = await this.get(ownerId, id);
    if (!existing) throw new Error("onboarding draft not found for user");
    if (existing.status === idempotentStatus) return { draft: existing, changed: false };
    throw new Error(`cannot ${operation} onboarding draft in ${existing.status} status`);
  }
}

export const activeOnboardingStatuses = ACTIVE_STATUSES;
