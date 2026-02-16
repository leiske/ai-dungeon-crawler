import { getModel, streamSimple } from "@mariozechner/pi-ai";
import type { AssistantMessage, ThinkingLevel } from "@mariozechner/pi-ai";
import { z } from "zod";
import { createAttackAction, createMoveAction, createUseItemAction, WAIT_ACTION } from "../action-utils.ts";
import type {
  LlmEvent,
  LlmEventHandler,
  LlmJournalMemoryEntry,
  LlmWorkingMemoryEntry,
} from "../llm-events.ts";
import { getOpenAICodexApiKey } from "../llm/auth.ts";
import type { Observation, PlayerAction, PlayerPolicy } from "../types.ts";
import { DEFAULT_PERSONA_ID, getPersonaById } from "./persona.ts";
import type { PersonaDefinition } from "./persona.ts";

const MODEL_PROVIDER = "openai-codex" as const;
const MODEL_ID = "gpt-5.3-codex" as const;

const CORE_SYSTEM_DIRECTIVES = [
  "You are a tactical policy for a deterministic dungeon crawler.",
  "Return exactly one JSON object and nothing else.",
  "Allowed outputs:",
  '{"kind":"WAIT"}',
  '{"kind":"MOVE","direction":"N|S|E|W"}',
  '{"kind":"ATTACK","direction":"N|S|E|W"}',
  '{"kind":"USE_ITEM","itemId":"potion"}',
  "Keep action fields at the top level.",
  "You may optionally include decision: {goal, keyObservations, risk, confidence, whyThisAction}.",
  "You may optionally include memory with this exact shape:",
  'memory: { workingUpdates: [{ kind, text, salience, confidence }], journalAppends: [{ kind, text, salience, confidence }] }',
  "workingUpdates.kind must be one of fact|plan|threat|target|blocked.",
  "journalAppends.kind must be one of persona|belief|long_goal|reflection.",
  "Each memory text must be concise single-line text.",
  "salience and confidence must be numbers in [0,1].",
  "Keep all free-form text (decision fields, memory text, and thinking text) in the active persona voice.",
  "Input payload uses compact keys and tuples:",
  't = turn, s = [x,y,hp,maxHp,potionCount], vt = [[x,y,tileCode]], ve = [[id,kindCode,x,y,hp,maxHp]], vp = recent visited [[x,y]], vm = memory {w,j}.',
  "tileCode uses F/W/E. kindCode uses m for enemy and p for player.",
  "If you include memory, use object entries, never plain strings.",
  "Do not include markdown fences or commentary.",
] as const;

const CORE_TURN_DIRECTIVES = [
  "Select the next action from the allowed action schema.",
  "Goal: reach the exit alive.",
  "Choose actions autonomously from the current state and memory.",
  "Use the compact payload below.",
] as const;

export interface LlmDecisionTrace {
  turn: number;
  action: PlayerAction;
  decision?: LlmDecision;
  memoryApplied?: {
    workingUpdates: number;
    journalAppends: number;
    journalCompactions: number;
  };
  latencyMs: number;
  rawJsonSnippet: string;
  rawResponse: string;
  thinking: string[];
  stopReason?: string;
  modelErrorMessage?: string;
  fallbackReason?: string;
  decisionParseError?: string;
  memoryParseError?: string;
  tokenUsage: {
    input: number;
    output: number;
    total: number;
  };
}

export interface LlmDecision {
  goal: string;
  keyObservations: string[];
  risk: string;
  confidence: number;
  whyThisAction: string;
}

type WorkingMemoryKind = "fact" | "plan" | "threat" | "target" | "blocked";
type JournalMemoryKind = "persona" | "belief" | "long_goal" | "reflection";

interface WorkingMemoryEntry {
  kind: WorkingMemoryKind;
  text: string;
  salience: number;
  confidence: number;
  turn: number;
}

interface JournalMemoryEntry {
  kind: JournalMemoryKind;
  text: string;
  salience: number;
  confidence: number;
  turn: number;
}

interface PolicyMemoryState {
  working: WorkingMemoryEntry[];
  journal: JournalMemoryEntry[];
}

interface ParsedMemoryPayload {
  workingUpdates: Array<Pick<WorkingMemoryEntry, "kind" | "text" | "salience" | "confidence">>;
  journalAppends: Array<Pick<JournalMemoryEntry, "kind" | "text" | "salience" | "confidence">>;
}

interface CompactPromptMemory {
  w: Array<[kind: WorkingMemoryKind, text: string, salience: number, confidence: number]>;
  j: Array<[kind: JournalMemoryKind, text: string, salience: number, confidence: number]>;
}

const MAX_WORKING_UPDATES_PER_TURN = 3;
const MAX_JOURNAL_APPENDS_PER_TURN = 2;
const MAX_WORKING_MEMORY_ENTRIES = 10;
const MAX_JOURNAL_MEMORY_ENTRIES = 40;
const MAX_PROMPT_WORKING_ENTRIES = 6;
const MAX_PROMPT_JOURNAL_ENTRIES = 8;
const MEMORY_TEXT_PATTERN = /^[^\r\n]+$/;

export interface CodexPolicyOptions {
  authPath?: string;
  reasoning?: ThinkingLevel;
  personaId?: string;
  onDecision?: (trace: LlmDecisionTrace) => void | Promise<void>;
  onEvent?: LlmEventHandler;
}

interface ParseActionResult {
  action: PlayerAction | null;
  decision?: LlmDecision;
  memory?: ParsedMemoryPayload;
  rawJsonSnippet: string;
  reason?: string;
  decisionParseError?: string;
  memoryParseError?: string;
}

const directionSchema = z.enum(["N", "S", "E", "W"]);

const llmActionSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("WAIT") }).strict(),
  z.object({ kind: z.literal("MOVE"), direction: directionSchema }).strict(),
  z.object({ kind: z.literal("ATTACK"), direction: directionSchema }).strict(),
  z.object({ kind: z.literal("USE_ITEM"), itemId: z.literal("potion") }).strict(),
]);

type LlmActionPayload = z.infer<typeof llmActionSchema>;

function normalizeRiskNumber(value: number): string {
  if (!Number.isFinite(value)) {
    return "unknown";
  }

  let normalized = value;
  if (normalized > 1 && normalized <= 100) {
    normalized /= 100;
  }

  const clamped = Math.max(0, Math.min(1, normalized));
  if (clamped < 0.34) {
    return "low";
  }

  if (clamped < 0.67) {
    return "medium";
  }

  return "high";
}

const decisionRiskSchema = z
  .union([z.string().trim().min(1).max(180), z.number().finite()])
  .transform((value) => (typeof value === "number" ? normalizeRiskNumber(value) : value));

const decisionSchema = z
  .object({
    goal: z.string().trim().min(1).max(180),
    keyObservations: z.array(z.string().trim().min(1).max(180)).min(1).max(5),
    risk: decisionRiskSchema,
    confidence: z.number().min(0).max(1),
    whyThisAction: z.string().trim().min(1).max(240),
  })
  .strict();

const workingMemoryKindSchema = z.enum(["fact", "plan", "threat", "target", "blocked"]);
const journalMemoryKindSchema = z.enum(["persona", "belief", "long_goal", "reflection"]);

const workingUpdateSchema = z
  .object({
    kind: workingMemoryKindSchema,
    text: z.string().trim().min(1).max(120).regex(MEMORY_TEXT_PATTERN, "must be single-line"),
    salience: z.number().min(0).max(1),
    confidence: z.number().min(0).max(1),
  })
  .strict();

const journalAppendSchema = z
  .object({
    kind: journalMemoryKindSchema,
    text: z.string().trim().min(1).max(180).regex(MEMORY_TEXT_PATTERN, "must be single-line"),
    salience: z.number().min(0).max(1),
    confidence: z.number().min(0).max(1),
  })
  .strict();

const memorySchema = z
  .object({
    workingUpdates: z.array(workingUpdateSchema).max(MAX_WORKING_UPDATES_PER_TURN).optional(),
    journalAppends: z.array(journalAppendSchema).max(MAX_JOURNAL_APPENDS_PER_TURN).optional(),
  })
  .strict()
  .refine(
    (value) => (value.workingUpdates?.length ?? 0) + (value.journalAppends?.length ?? 0) > 0,
    "memory must include at least one update",
  );

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function describeSchemaError(error: z.ZodError): string {
  const issue = error.issues[0];
  if (!issue) {
    return "invalid action payload";
  }

  const path = issue.path.length > 0 ? issue.path.join(".") : "root";
  return `${path}: ${issue.message}`;
}

function toPlayerAction(action: LlmActionPayload): PlayerAction {
  switch (action.kind) {
    case "WAIT":
      return WAIT_ACTION;
    case "MOVE":
      return createMoveAction(action.direction);
    case "ATTACK":
      return createAttackAction(action.direction);
    case "USE_ITEM":
      return createUseItemAction(action.itemId);
  }
}

function extractMessageContent(message: AssistantMessage): {
  text: string;
  thinking: string[];
} {
  const textSegments: string[] = [];
  const thinkingSegments: string[] = [];
  for (const content of message.content) {
    if (content.type === "text") {
      textSegments.push(content.text);
    }
    if (content.type === "thinking") {
      thinkingSegments.push(content.thinking);
    }
  }
  return {
    text: textSegments.join("\n").trim(),
    thinking: thinkingSegments.map((segment) => segment.trim()).filter((segment) => segment.length > 0),
  };
}

function extractJsonSnippet(text: string): string | null {
  const trimmed = text.trim();
  if (!trimmed) {
    return null;
  }

  if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
    return trimmed;
  }

  const fencedMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fencedMatch?.[1]) {
    const fenced = fencedMatch[1].trim();
    if (fenced.startsWith("{") && fenced.endsWith("}")) {
      return fenced;
    }
  }

  const firstBrace = trimmed.indexOf("{");
  if (firstBrace < 0) {
    return null;
  }

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = firstBrace; i < trimmed.length; i += 1) {
    const char = trimmed[i];
    if (!char) {
      continue;
    }

    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }

    if (char === '"') {
      inString = true;
      continue;
    }

    if (char === "{") {
      depth += 1;
      continue;
    }

    if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        return trimmed.slice(firstBrace, i + 1);
      }
    }
  }

  return null;
}

function parseActionObject(value: unknown): ParseActionResult {
  if (!isRecord(value)) {
    return { action: null, rawJsonSnippet: "", reason: "action payload must be an object" };
  }

  const { decision: decisionValue, memory: memoryValue, ...actionPayload } = value;
  const parsed = llmActionSchema.safeParse(actionPayload);
  if (!parsed.success) {
    return {
      action: null,
      rawJsonSnippet: "",
      reason: describeSchemaError(parsed.error),
    };
  }

  let decision: LlmDecision | undefined;
  let decisionParseError: string | undefined;
  let memory: ParsedMemoryPayload | undefined;
  let memoryParseError: string | undefined;

  if (decisionValue !== undefined) {
    const parsedDecision = decisionSchema.safeParse(decisionValue);
    if (parsedDecision.success) {
      decision = parsedDecision.data;
    } else {
      decisionParseError = describeSchemaError(parsedDecision.error);
    }
  }

  if (memoryValue !== undefined) {
    const parsedMemory = memorySchema.safeParse(memoryValue);
    if (parsedMemory.success) {
      memory = {
        workingUpdates: parsedMemory.data.workingUpdates ?? [],
        journalAppends: parsedMemory.data.journalAppends ?? [],
      };
    } else {
      memoryParseError = describeSchemaError(parsedMemory.error);
    }
  }

  return {
    action: toPlayerAction(parsed.data),
    decision,
    memory,
    rawJsonSnippet: "",
    decisionParseError,
    memoryParseError,
  };
}

function parseActionFromText(text: string): ParseActionResult {
  const jsonSnippet = extractJsonSnippet(text);
  if (!jsonSnippet) {
    return { action: null, rawJsonSnippet: "", reason: "response does not contain JSON" };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonSnippet);
  } catch {
    return { action: null, rawJsonSnippet: jsonSnippet, reason: "invalid JSON" };
  }

  const action = parseActionObject(parsed);
  return {
    ...action,
    rawJsonSnippet: jsonSnippet,
  };
}

type CompactTileCode = "F" | "W" | "E";
type CompactEntityCode = "m" | "p";

interface CompactObservation {
  t: number;
  s: [x: number, y: number, hp: number, maxHp: number, potionCount: number];
  vt: Array<[x: number, y: number, tileCode: CompactTileCode]>;
  ve: Array<[id: number, kindCode: CompactEntityCode, x: number, y: number, hp: number, maxHp: number]>;
  vp: Array<[x: number, y: number]>;
  vm: CompactPromptMemory;
}

function toCompactTileCode(tile: Observation["visibleTiles"][number]["tile"]): CompactTileCode {
  switch (tile) {
    case "FLOOR":
      return "F";
    case "WALL":
      return "W";
    case "EXIT":
      return "E";
  }
}

function toCompactEntityCode(kind: Observation["visibleEntities"][number]["kind"]): CompactEntityCode {
  return kind === "enemy" ? "m" : "p";
}

function memoryEntryPriority(turn: number, salience: number): number {
  const recencyBoost = 1 / (1 + Math.max(0, turn));
  return salience * 0.75 + recencyBoost * 0.25;
}

function normalizeMemoryText(text: string): string {
  return text.replace(/[\r\n]+/g, " ").replace(/\s+/g, " ").trim();
}

function selectMemoryForPrompt(memory: PolicyMemoryState, currentTurn: number): CompactPromptMemory {
  const working = [...memory.working]
    .sort((left, right) => {
      const rightScore = memoryEntryPriority(currentTurn - right.turn, right.salience);
      const leftScore = memoryEntryPriority(currentTurn - left.turn, left.salience);
      if (rightScore !== leftScore) {
        return rightScore - leftScore;
      }
      return right.turn - left.turn;
    })
    .slice(0, MAX_PROMPT_WORKING_ENTRIES)
    .map<[WorkingMemoryKind, string, number, number]>((entry) => [
      entry.kind,
      entry.text,
      entry.salience,
      entry.confidence,
    ]);

  const journal = [...memory.journal]
    .sort((left, right) => {
      const rightScore = memoryEntryPriority(currentTurn - right.turn, right.salience);
      const leftScore = memoryEntryPriority(currentTurn - left.turn, left.salience);
      if (rightScore !== leftScore) {
        return rightScore - leftScore;
      }
      return right.turn - left.turn;
    })
    .slice(0, MAX_PROMPT_JOURNAL_ENTRIES)
    .map<[JournalMemoryKind, string, number, number]>((entry) => [
      entry.kind,
      entry.text,
      entry.salience,
      entry.confidence,
    ]);

  return {
    w: working,
    j: journal,
  };
}

function compactJournalMemory(journal: JournalMemoryEntry[], turn: number): {
  journal: JournalMemoryEntry[];
  compactions: number;
} {
  let nextJournal = [...journal];
  let compactions = 0;

  while (nextJournal.length > MAX_JOURNAL_MEMORY_ENTRIES) {
    const removable = [...nextJournal]
      .sort((left, right) => {
        const leftPersonaPenalty = left.kind === "persona" ? 1 : 0;
        const rightPersonaPenalty = right.kind === "persona" ? 1 : 0;
        if (leftPersonaPenalty !== rightPersonaPenalty) {
          return leftPersonaPenalty - rightPersonaPenalty;
        }
        if (left.salience !== right.salience) {
          return left.salience - right.salience;
        }
        return left.turn - right.turn;
      })
      .slice(0, 6);

    if (removable.length < 2) {
      break;
    }

    const removableSet = new Set(removable.map((entry) => `${entry.kind}:${entry.turn}:${entry.text}`));
    const keptEntries = nextJournal.filter((entry) => !removableSet.has(`${entry.kind}:${entry.turn}:${entry.text}`));
    const summaryText = removable
      .map((entry) => `${entry.kind}:${entry.text}`)
      .join(" | ")
      .slice(0, 180);

    const confidenceSum = removable.reduce((sum, entry) => sum + entry.confidence, 0);
    const salienceMax = removable.reduce((max, entry) => Math.max(max, entry.salience), 0);
    const summaryEntry: JournalMemoryEntry = {
      kind: "reflection",
      text: normalizeMemoryText(summaryText),
      salience: Math.max(0.35, Math.min(1, salienceMax * 0.85)),
      confidence: Math.max(0.35, Math.min(1, confidenceSum / removable.length)),
      turn,
    };

    nextJournal = [...keptEntries, summaryEntry];
    compactions += 1;
  }

  return {
    journal: nextJournal,
    compactions,
  };
}

function applyMemoryUpdates(
  memory: PolicyMemoryState,
  updates: ParsedMemoryPayload | undefined,
  turn: number,
): {
  nextMemory: PolicyMemoryState;
  applied: { workingUpdates: number; journalAppends: number; journalCompactions: number };
} {
  if (!updates) {
    return {
      nextMemory: memory,
      applied: { workingUpdates: 0, journalAppends: 0, journalCompactions: 0 },
    };
  }

  const nextWorking = [
    ...memory.working,
    ...updates.workingUpdates.map((update) => ({
      kind: update.kind,
      text: normalizeMemoryText(update.text),
      salience: update.salience,
      confidence: update.confidence,
      turn,
    })),
  ].slice(-MAX_WORKING_MEMORY_ENTRIES);

  const nextJournalRaw = [
    ...memory.journal,
    ...updates.journalAppends.map((append) => ({
      kind: append.kind,
      text: normalizeMemoryText(append.text),
      salience: append.salience,
      confidence: append.confidence,
      turn,
    })),
  ];

  const compacted = compactJournalMemory(nextJournalRaw, turn);

  return {
    nextMemory: {
      working: nextWorking,
      journal: compacted.journal,
    },
    applied: {
      workingUpdates: updates.workingUpdates.length,
      journalAppends: updates.journalAppends.length,
      journalCompactions: compacted.compactions,
    },
  };
}

function toLlmWorkingMemoryEntry(entry: WorkingMemoryEntry): LlmWorkingMemoryEntry {
  return {
    kind: entry.kind,
    text: entry.text,
    salience: entry.salience,
    confidence: entry.confidence,
    turn: entry.turn,
  };
}

function toLlmJournalMemoryEntry(entry: JournalMemoryEntry): LlmJournalMemoryEntry {
  return {
    kind: entry.kind,
    text: entry.text,
    salience: entry.salience,
    confidence: entry.confidence,
    turn: entry.turn,
  };
}

export function compactObservationForPrompt(
  observation: Observation,
  promptMemory: CompactPromptMemory,
): CompactObservation {
  return {
    t: observation.turn,
    s: [
      observation.self.x,
      observation.self.y,
      observation.self.hp,
      observation.self.maxHp,
      observation.self.potionCount,
    ],
    vt: observation.visibleTiles.map((tile) => [tile.x, tile.y, toCompactTileCode(tile.tile)]),
    ve: observation.visibleEntities.map((entity) => [
      entity.id,
      toCompactEntityCode(entity.kind),
      entity.x,
      entity.y,
      entity.hp,
      entity.maxHp,
    ]),
    vp: observation.visitedPositions.slice(-10).map((position) => [position.x, position.y]),
    vm: promptMemory,
  };
}

function buildSystemPrompt(persona: PersonaDefinition): string {
  return [...CORE_SYSTEM_DIRECTIVES, ...persona.systemDirectives].join("\n");
}

function buildPrompt(
  observation: Observation,
  promptMemory: CompactPromptMemory,
  persona: PersonaDefinition,
): string {
  const compactObservation = compactObservationForPrompt(observation, promptMemory);
  return [
    ...CORE_TURN_DIRECTIVES,
    ...persona.turnDirectives,
    "State JSON:",
    JSON.stringify(compactObservation),
  ].join("\n");
}

function describeError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

export class LlmCodexPolicy implements PlayerPolicy {
  private readonly model = getModel(MODEL_PROVIDER, MODEL_ID);
  private readonly decisionTrace: LlmDecisionTrace[] = [];
  private memory: PolicyMemoryState = {
    working: [],
    journal: [],
  };
  private readonly authPath?: string;
  private readonly reasoning: ThinkingLevel;
  private readonly persona: PersonaDefinition;
  private readonly onDecision?: (trace: LlmDecisionTrace) => void | Promise<void>;
  private readonly onEvent?: LlmEventHandler;

  public constructor(options: CodexPolicyOptions = {}) {
    this.authPath = options.authPath;
    this.reasoning = options.reasoning ?? "low";
    this.persona = getPersonaById(options.personaId ?? DEFAULT_PERSONA_ID);
    this.onDecision = options.onDecision;
    this.onEvent = options.onEvent;
  }

  public getDecisionTrace(): readonly LlmDecisionTrace[] {
    return [...this.decisionTrace];
  }

  public getReasoningLevel(): ThinkingLevel {
    return this.reasoning;
  }

  public getPersonaId(): string {
    return this.persona.id;
  }

  public getPersonaDescription(): string {
    return this.persona.description;
  }

  private async emitDecision(trace: LlmDecisionTrace): Promise<void> {
    if (!this.onDecision) {
      return;
    }

    try {
      await this.onDecision(trace);
    } catch {
      // Decision logging must never break action selection.
    }
  }

  private async emitEvent(event: LlmEvent): Promise<void> {
    if (!this.onEvent) {
      return;
    }

    try {
      await this.onEvent(event);
    } catch {
      // Live event rendering must never break action selection.
    }
  }

  public async chooseAction(observation: Observation): Promise<PlayerAction> {
    const startedAt = Date.now();
    const playerId = observation.self.id;
    const promptMemory = selectMemoryForPrompt(this.memory, observation.turn);
    const prompt = buildPrompt(observation, promptMemory, this.persona);
    const systemPrompt = buildSystemPrompt(this.persona);

    await this.emitEvent({
      type: "LLM_REQUEST_STARTED",
      turn: observation.turn,
      playerId,
    });

    try {
      const { apiKey } = await getOpenAICodexApiKey(this.authPath);
      const stream = streamSimple(
        this.model,
        {
          systemPrompt,
          messages: [
            {
              role: "user",
              content: prompt,
              timestamp: Date.now(),
            },
          ],
        },
        {
          apiKey,
          reasoning: this.reasoning,
          maxTokens: 320,
        },
      );

      for await (const event of stream) {
        switch (event.type) {
          case "thinking_start":
            await this.emitEvent({
              type: "LLM_THINKING_STARTED",
              turn: observation.turn,
              playerId,
            });
            break;
          case "thinking_delta":
            if (event.delta.length > 0) {
              await this.emitEvent({
                type: "LLM_THINKING_DELTA",
                turn: observation.turn,
                playerId,
                delta: event.delta,
              });
            }
            break;
          case "thinking_end":
            await this.emitEvent({
              type: "LLM_THINKING_ENDED",
              turn: observation.turn,
              playerId,
            });
            break;
          case "text_start":
            await this.emitEvent({
              type: "LLM_OUTPUT_STARTED",
              turn: observation.turn,
              playerId,
            });
            break;
          case "text_delta":
            if (event.delta.length > 0) {
              await this.emitEvent({
                type: "LLM_OUTPUT_DELTA",
                turn: observation.turn,
                playerId,
                delta: event.delta,
              });
            }
            break;
          case "text_end":
            await this.emitEvent({
              type: "LLM_OUTPUT_ENDED",
              turn: observation.turn,
              playerId,
            });
            break;
          default:
            break;
        }
      }

      const response = await stream.result();

      const { text: rawResponse, thinking } = extractMessageContent(response);
      const stopReason = response.stopReason;
      const modelErrorMessage = response.errorMessage;

      let parsed: ParseActionResult;
      if (stopReason === "error") {
        parsed = {
          action: null,
          rawJsonSnippet: "",
          reason: modelErrorMessage
            ? `llm_stop_error: ${modelErrorMessage}`
            : "llm_stop_error: model returned stopReason=error",
        };
      } else {
        parsed = parseActionFromText(rawResponse);
      }

      const action = parsed.action ?? WAIT_ACTION;
      const memoryUpdate = applyMemoryUpdates(this.memory, parsed.memory, observation.turn);
      this.memory = memoryUpdate.nextMemory;

      const committedWorking: LlmWorkingMemoryEntry[] = (parsed.memory?.workingUpdates ?? []).map(
        (update) => ({
          kind: update.kind,
          text: normalizeMemoryText(update.text),
          salience: update.salience,
          confidence: update.confidence,
          turn: observation.turn,
        }),
      );

      const committedJournal: LlmJournalMemoryEntry[] = (parsed.memory?.journalAppends ?? []).map(
        (append) => ({
          kind: append.kind,
          text: normalizeMemoryText(append.text),
          salience: append.salience,
          confidence: append.confidence,
          turn: observation.turn,
        }),
      );

      await this.emitEvent({
        type: "LLM_MEMORY_UPDATED",
        turn: observation.turn,
        playerId,
        applied: memoryUpdate.applied,
        committedWorking,
        committedJournal,
        working: memoryUpdate.nextMemory.working.map((entry) => toLlmWorkingMemoryEntry(entry)),
        journal: memoryUpdate.nextMemory.journal.map((entry) => toLlmJournalMemoryEntry(entry)),
      });

      const trace: LlmDecisionTrace = {
        turn: observation.turn,
        action,
        decision: parsed.decision,
        memoryApplied: memoryUpdate.applied,
        latencyMs: Date.now() - startedAt,
        rawJsonSnippet: parsed.rawJsonSnippet,
        rawResponse,
        thinking,
        stopReason,
        modelErrorMessage,
        fallbackReason: parsed.reason,
        decisionParseError: parsed.decisionParseError,
        memoryParseError: parsed.memoryParseError,
        tokenUsage: {
          input: response.usage.input,
          output: response.usage.output,
          total: response.usage.totalTokens,
        },
      };

      this.decisionTrace.push(trace);
      await this.emitDecision(trace);

      await this.emitEvent({
        type: "LLM_REQUEST_COMPLETED",
        turn: observation.turn,
        playerId,
        action,
        latencyMs: trace.latencyMs,
        stopReason,
        whyThisAction: trace.decision?.whyThisAction,
        confidence: trace.decision?.confidence,
        tokenUsage: trace.tokenUsage,
        issue:
          trace.fallbackReason ??
          trace.decisionParseError ??
          trace.memoryParseError ??
          trace.modelErrorMessage,
      });

      return action;
    } catch (error) {
      const message = describeError(error);
      const trace: LlmDecisionTrace = {
        turn: observation.turn,
        action: WAIT_ACTION,
        latencyMs: Date.now() - startedAt,
        rawJsonSnippet: "",
        rawResponse: "",
        thinking: [],
        stopReason: "error",
        modelErrorMessage: message,
        fallbackReason: `llm_error: ${message}`,
        tokenUsage: {
          input: 0,
          output: 0,
          total: 0,
        },
      };

      this.decisionTrace.push(trace);
      await this.emitDecision(trace);

      await this.emitEvent({
        type: "LLM_REQUEST_FAILED",
        turn: observation.turn,
        playerId,
        message,
      });

      return WAIT_ACTION;
    }
  }
}
