import { completeSimple, getModel } from "@mariozechner/pi-ai";
import type { AssistantMessage, ThinkingLevel } from "@mariozechner/pi-ai";
import { z } from "zod";
import { createAttackAction, createMoveAction, createUseItemAction, WAIT_ACTION } from "../action-utils.ts";
import { getOpenAICodexApiKey } from "../llm/auth.ts";
import type { Observation, PlayerAction, PlayerPolicy } from "../types.ts";

const MODEL_PROVIDER = "openai-codex" as const;
const MODEL_ID = "gpt-5.3-codex" as const;

const SYSTEM_PROMPT = [
  "You are a tactical policy for a deterministic dungeon crawler.",
  "Return exactly one JSON object and nothing else.",
  "Allowed outputs:",
  '{"kind":"WAIT"}',
  '{"kind":"MOVE","direction":"N|S|E|W"}',
  '{"kind":"ATTACK","direction":"N|S|E|W"}',
  '{"kind":"USE_ITEM","itemId":"potion"}',
  "Keep action fields at the top level.",
  "You may optionally include decision: {goal, keyObservations, risk, confidence, whyThisAction}.",
  "Input payload uses compact keys and tuples:",
  't = turn, s = [x,y,hp,maxHp,potionCount], vt = [[x,y,tileCode]], ve = [[id,kindCode,x,y,hp,maxHp]], vp = recent visited [[x,y]].',
  "tileCode uses F/W/E. kindCode uses m for enemy and p for player.",
  "Use vp to reduce unnecessary backtracking when safe.",
  "Do not include markdown fences or commentary.",
].join("\n");

export interface LlmDecisionTrace {
  turn: number;
  action: PlayerAction;
  decision?: LlmDecision;
  latencyMs: number;
  rawJsonSnippet: string;
  rawResponse: string;
  thinking: string[];
  stopReason?: string;
  modelErrorMessage?: string;
  fallbackReason?: string;
  decisionParseError?: string;
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

export interface CodexPolicyOptions {
  authPath?: string;
  reasoning?: ThinkingLevel;
  onDecision?: (trace: LlmDecisionTrace) => void | Promise<void>;
}

interface ParseActionResult {
  action: PlayerAction | null;
  decision?: LlmDecision;
  rawJsonSnippet: string;
  reason?: string;
  decisionParseError?: string;
}

const directionSchema = z.enum(["N", "S", "E", "W"]);

const llmActionSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("WAIT") }).strict(),
  z.object({ kind: z.literal("MOVE"), direction: directionSchema }).strict(),
  z.object({ kind: z.literal("ATTACK"), direction: directionSchema }).strict(),
  z.object({ kind: z.literal("USE_ITEM"), itemId: z.literal("potion") }).strict(),
]);

type LlmActionPayload = z.infer<typeof llmActionSchema>;

const decisionSchema = z
  .object({
    goal: z.string().trim().min(1).max(180),
    keyObservations: z.array(z.string().trim().min(1).max(180)).min(1).max(5),
    risk: z.string().trim().min(1).max(180),
    confidence: z.number().min(0).max(1),
    whyThisAction: z.string().trim().min(1).max(240),
  })
  .strict();

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

  const { decision: decisionValue, ...actionPayload } = value;
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
  if (decisionValue !== undefined) {
    const parsedDecision = decisionSchema.safeParse(decisionValue);
    if (parsedDecision.success) {
      decision = parsedDecision.data;
    } else {
      decisionParseError = describeSchemaError(parsedDecision.error);
    }
  }

  return {
    action: toPlayerAction(parsed.data),
    decision,
    rawJsonSnippet: "",
    decisionParseError,
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

export function compactObservationForPrompt(observation: Observation): CompactObservation {
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
  };
}

function buildPrompt(observation: Observation): string {
  const compactObservation = compactObservationForPrompt(observation);
  return [
    "Choose the next action.",
    "Objective: stay alive and reach the exit tile if possible.",
    "Use the compact payload below.",
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
  private readonly authPath?: string;
  private readonly reasoning: ThinkingLevel;
  private readonly onDecision?: (trace: LlmDecisionTrace) => void | Promise<void>;

  public constructor(options: CodexPolicyOptions = {}) {
    this.authPath = options.authPath;
    this.reasoning = options.reasoning ?? "low";
    this.onDecision = options.onDecision;
  }

  public getDecisionTrace(): readonly LlmDecisionTrace[] {
    return [...this.decisionTrace];
  }

  public getReasoningLevel(): ThinkingLevel {
    return this.reasoning;
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

  public async chooseAction(observation: Observation): Promise<PlayerAction> {
    const startedAt = Date.now();
    const prompt = buildPrompt(observation);

    try {
      const { apiKey } = await getOpenAICodexApiKey(this.authPath);
      const response = await completeSimple(
        this.model,
        {
          systemPrompt: SYSTEM_PROMPT,
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
          maxTokens: 180,
        },
      );

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

      const trace: LlmDecisionTrace = {
        turn: observation.turn,
        action,
        decision: parsed.decision,
        latencyMs: Date.now() - startedAt,
        rawJsonSnippet: parsed.rawJsonSnippet,
        rawResponse,
        thinking,
        stopReason,
        modelErrorMessage,
        fallbackReason: parsed.reason,
        decisionParseError: parsed.decisionParseError,
        tokenUsage: {
          input: response.usage.input,
          output: response.usage.output,
          total: response.usage.totalTokens,
        },
      };

      this.decisionTrace.push(trace);
      await this.emitDecision(trace);

      return action;
    } catch (error) {
      const trace: LlmDecisionTrace = {
        turn: observation.turn,
        action: WAIT_ACTION,
        latencyMs: Date.now() - startedAt,
        rawJsonSnippet: "",
        rawResponse: "",
        thinking: [],
        stopReason: "error",
        modelErrorMessage: describeError(error),
        fallbackReason: `llm_error: ${describeError(error)}`,
        tokenUsage: {
          input: 0,
          output: 0,
          total: 0,
        },
      };

      this.decisionTrace.push(trace);
      await this.emitDecision(trace);

      return WAIT_ACTION;
    }
  }
}
