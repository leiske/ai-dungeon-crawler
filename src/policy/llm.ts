import { completeSimple, getModel } from "@mariozechner/pi-ai";
import type { AssistantMessage, ThinkingLevel } from "@mariozechner/pi-ai";
import { createAttackAction, createMoveAction, createUseItemAction, WAIT_ACTION } from "../action-utils.ts";
import { getOpenAICodexApiKey } from "../llm/auth.ts";
import type { Direction, Observation, PlayerAction, PlayerPolicy } from "../types.ts";

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
  "Use visitedPositions to reduce unnecessary backtracking when safe.",
  "Do not include markdown fences or commentary.",
].join("\n");

export interface LlmDecisionTrace {
  turn: number;
  action: PlayerAction;
  latencyMs: number;
  rawResponse: string;
  stopReason?: string;
  modelErrorMessage?: string;
  fallbackReason?: string;
  tokenUsage: {
    input: number;
    output: number;
    total: number;
  };
}

export interface CodexPolicyOptions {
  authPath?: string;
  reasoning?: ThinkingLevel;
}

interface ParseActionResult {
  action: PlayerAction | null;
  reason?: string;
}

function isDirection(value: unknown): value is Direction {
  return value === "N" || value === "S" || value === "E" || value === "W";
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function extractTextContent(message: AssistantMessage): string {
  const segments: string[] = [];
  for (const content of message.content) {
    if (content.type === "text") {
      segments.push(content.text);
    }
  }
  return segments.join("\n").trim();
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
  if (!isObject(value)) {
    return { action: null, reason: "response is not an object" };
  }

  const kind = value.kind;
  if (kind === "WAIT") {
    return { action: WAIT_ACTION };
  }

  if (kind === "MOVE") {
    const direction = value.direction;
    if (!isDirection(direction)) {
      return { action: null, reason: "MOVE requires direction N/S/E/W" };
    }
    return { action: createMoveAction(direction) };
  }

  if (kind === "ATTACK") {
    const direction = value.direction;
    if (!isDirection(direction)) {
      return { action: null, reason: "ATTACK requires direction N/S/E/W" };
    }
    return { action: createAttackAction(direction) };
  }

  if (kind === "USE_ITEM") {
    const itemId = value.itemId;
    if (itemId !== "potion") {
      return { action: null, reason: "USE_ITEM currently supports only itemId='potion'" };
    }
    return { action: createUseItemAction("potion") };
  }

  return { action: null, reason: "unknown action kind" };
}

function parseActionFromText(text: string): ParseActionResult {
  const jsonSnippet = extractJsonSnippet(text);
  if (!jsonSnippet) {
    return { action: null, reason: "response does not contain JSON" };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonSnippet);
  } catch {
    return { action: null, reason: "invalid JSON" };
  }

  return parseActionObject(parsed);
}

function buildPrompt(observation: Observation): string {
  return [
    "Choose the next action from the current observation.",
    "Objective: stay alive and reach the exit tile if possible.",
    "visitedPositions lists coordinates you have already visited.",
    "Observation JSON:",
    JSON.stringify(observation),
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

  public constructor(options: CodexPolicyOptions = {}) {
    this.authPath = options.authPath;
    this.reasoning = options.reasoning ?? "low";
  }

  public getDecisionTrace(): readonly LlmDecisionTrace[] {
    return [...this.decisionTrace];
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

      const rawResponse = extractTextContent(response);
      const stopReason = response.stopReason;
      const modelErrorMessage = response.errorMessage;

      let parsed: ParseActionResult;
      if (stopReason === "error") {
        parsed = {
          action: null,
          reason: modelErrorMessage
            ? `llm_stop_error: ${modelErrorMessage}`
            : "llm_stop_error: model returned stopReason=error",
        };
      } else {
        parsed = parseActionFromText(rawResponse);
      }

      const action = parsed.action ?? WAIT_ACTION;

      this.decisionTrace.push({
        turn: observation.turn,
        action,
        latencyMs: Date.now() - startedAt,
        rawResponse,
        stopReason,
        modelErrorMessage,
        fallbackReason: parsed.reason,
        tokenUsage: {
          input: response.usage.input,
          output: response.usage.output,
          total: response.usage.totalTokens,
        },
      });

      return action;
    } catch (error) {
      this.decisionTrace.push({
        turn: observation.turn,
        action: WAIT_ACTION,
        latencyMs: Date.now() - startedAt,
        rawResponse: "",
        stopReason: "error",
        modelErrorMessage: describeError(error),
        fallbackReason: `llm_error: ${describeError(error)}`,
        tokenUsage: {
          input: 0,
          output: 0,
          total: 0,
        },
      });

      return WAIT_ACTION;
    }
  }
}
