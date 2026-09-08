import { randomUUID } from "node:crypto";

export type MemoryKind = "profile" | "project";
export type MemoryOwnerId = number | string;

export interface Memory {
  id: string;
  userId: string;
  kind: MemoryKind;
  content: string;
  projectName?: string;
  createdAt: string;
  updatedAt: string;
}

export interface CreateMemoryInput {
  userId: MemoryOwnerId;
  kind: MemoryKind;
  content: string;
  projectName?: string;
  consent: boolean;
}

export interface UpdateMemoryInput {
  content?: string;
  projectName?: string;
  consent: boolean;
}

export interface MemoryStore {
  list(userId: MemoryOwnerId, kind?: MemoryKind): Memory[];
  create(input: CreateMemoryInput): Memory;
  update(userId: MemoryOwnerId, memoryId: string, input: UpdateMemoryInput): Memory | undefined;
  delete(userId: MemoryOwnerId, memoryId: string): boolean;
  deleteAll(userId: MemoryOwnerId): number;
}

export class MemoryConsentRequiredError extends Error {
  constructor() {
    super("Explicit consent is required before storing memory");
    this.name = "MemoryConsentRequiredError";
  }
}

export class MemoryValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MemoryValidationError";
  }
}

const MAX_MEMORY_CONTENT_LENGTH = 4_000;
const MAX_PROJECT_NAME_LENGTH = 200;

function normalizeOwnerId(userId: MemoryOwnerId): string {
  const normalized = String(userId).trim();
  if (!normalized) throw new MemoryValidationError("A user id is required");
  return normalized;
}

function normalizeText(
  value: string | undefined,
  fieldName: string,
  maxLength: number,
): string | undefined {
  if (value === undefined) return undefined;
  const normalized = value.trim();
  if (!normalized) throw new MemoryValidationError(`${fieldName} must not be empty`);
  if (normalized.length > maxLength) throw new MemoryValidationError(`${fieldName} is too long`);
  return normalized;
}

function validateKind(kind: MemoryKind): void {
  if (kind !== "profile" && kind !== "project") {
    throw new MemoryValidationError("Memory kind must be profile or project");
  }
}

function copyMemory(memory: Memory): Memory {
  return { ...memory };
}

export class InMemoryMemoryStore implements MemoryStore {
  private readonly memories = new Map<string, Memory[]>();

  list(userId: MemoryOwnerId, kind?: MemoryKind): Memory[] {
    const ownerId = normalizeOwnerId(userId);
    if (kind !== undefined) validateKind(kind);
    return (this.memories.get(ownerId) ?? [])
      .filter((memory) => kind === undefined || memory.kind === kind)
      .map(copyMemory);
  }

  create(input: CreateMemoryInput): Memory {
    if (input.consent !== true) throw new MemoryConsentRequiredError();
    const userId = normalizeOwnerId(input.userId);
    validateKind(input.kind);
    const content = normalizeText(input.content, "Memory content", MAX_MEMORY_CONTENT_LENGTH);
    const projectName = normalizeText(input.projectName, "Project name", MAX_PROJECT_NAME_LENGTH);
    if (!content) throw new MemoryValidationError("Memory content must not be empty");

    const now = new Date().toISOString();
    const memory: Memory = {
      id: randomUUID(),
      userId,
      kind: input.kind,
      content,
      ...(projectName ? { projectName } : {}),
      createdAt: now,
      updatedAt: now,
    };
    const ownerMemories = this.memories.get(userId) ?? [];
    ownerMemories.push(memory);
    this.memories.set(userId, ownerMemories);
    return copyMemory(memory);
  }

  update(userId: MemoryOwnerId, memoryId: string, input: UpdateMemoryInput): Memory | undefined {
    if (input.consent !== true) throw new MemoryConsentRequiredError();
    const ownerId = normalizeOwnerId(userId);
    const normalizedId = memoryId.trim();
    if (!normalizedId) throw new MemoryValidationError("A memory id is required");
    const memory = this.memories.get(ownerId)?.find((candidate) => candidate.id === normalizedId);
    if (!memory) return undefined;

    const content = normalizeText(input.content, "Memory content", MAX_MEMORY_CONTENT_LENGTH);
    const projectName = normalizeText(input.projectName, "Project name", MAX_PROJECT_NAME_LENGTH);
    if (input.content !== undefined) memory.content = content ?? memory.content;
    if (input.projectName !== undefined) {
      if (projectName) memory.projectName = projectName;
      else delete memory.projectName;
    }
    memory.updatedAt = new Date().toISOString();
    return copyMemory(memory);
  }

  delete(userId: MemoryOwnerId, memoryId: string): boolean {
    const ownerId = normalizeOwnerId(userId);
    const ownerMemories = this.memories.get(ownerId);
    if (!ownerMemories) return false;
    const index = ownerMemories.findIndex((memory) => memory.id === memoryId.trim());
    if (index === -1) return false;
    ownerMemories.splice(index, 1);
    if (ownerMemories.length === 0) this.memories.delete(ownerId);
    return true;
  }

  deleteAll(userId: MemoryOwnerId): number {
    const ownerId = normalizeOwnerId(userId);
    const count = this.memories.get(ownerId)?.length ?? 0;
    this.memories.delete(ownerId);
    return count;
  }
}
