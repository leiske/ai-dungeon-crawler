import { GreedyEnemyController } from "./src/enemy/greedy.ts";
import { LlmCodexPolicy } from "./src/policy/llm.ts";
import type { LlmDecisionTrace } from "./src/policy/llm.ts";
import { runEpisode } from "./src/run.ts";
import { createScenario } from "./src/scenario.ts";
import { TerminalMapRenderer } from "./src/terminal-map-renderer.ts";
import type { ScenarioDefinition } from "./src/types.ts";

interface CliOptions {
  maxTurns?: number;
  minimalLogs: boolean;
  personaId?: string;
}

function parsePositiveInteger(value: string, flag: string): number {
  if (!/^\d+$/.test(value)) {
    throw new Error(`Invalid value for ${flag}: '${value}'. Expected a positive integer.`);
  }

  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`Invalid value for ${flag}: '${value}'. Expected a positive integer.`);
  }

  return parsed;
}

function parseCliOptions(argv: readonly string[]): CliOptions {
  let maxTurns: number | undefined;
  let minimalLogs = false;
  let personaId: string | undefined;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === undefined) {
      continue;
    }

    if (arg === "--max-turns") {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith("-")) {
        throw new Error("Missing value for --max-turns. Usage: --max-turns <number>");
      }
      maxTurns = parsePositiveInteger(value, "--max-turns");
      index += 1;
      continue;
    }

    if (arg.startsWith("--max-turns=")) {
      const value = arg.slice("--max-turns=".length);
      if (value.length === 0) {
        throw new Error("Missing value for --max-turns. Usage: --max-turns <number>");
      }
      maxTurns = parsePositiveInteger(value, "--max-turns");
      continue;
    }

    if (arg === "--minimal-logs") {
      minimalLogs = true;
      continue;
    }

    if (arg === "--persona") {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith("-")) {
        throw new Error("Missing value for --persona. Usage: --persona <id>");
      }
      personaId = value;
      index += 1;
      continue;
    }

    if (arg.startsWith("--persona=")) {
      const value = arg.slice("--persona=".length);
      if (value.length === 0) {
        throw new Error("Missing value for --persona. Usage: --persona <id>");
      }
      personaId = value;
      continue;
    }
  }

  return { maxTurns, minimalLogs, personaId };
}

function applyScenarioOverrides(
  scenario: ScenarioDefinition,
  options: CliOptions,
): ScenarioDefinition {
  if (options.maxTurns === undefined) {
    return scenario;
  }

  return {
    ...scenario,
    rules: {
      ...scenario.rules,
      maxTurns: options.maxTurns,
    },
  };
}

function formatMetrics(metrics: {
  win: boolean;
  turnsSurvived: number;
  damageTaken: number;
  damageDealt: number;
  potionsUsed: number;
  enemiesKilled: number;
}): string {
  return [
    `win=${metrics.win}`,
    `turnsSurvived=${metrics.turnsSurvived}`,
    `damageTaken=${metrics.damageTaken}`,
    `damageDealt=${metrics.damageDealt}`,
    `potionsUsed=${metrics.potionsUsed}`,
    `enemiesKilled=${metrics.enemiesKilled}`,
  ].join(", ");
}

function formatAction(action: LlmDecisionTrace["action"]): string {
  switch (action.kind) {
    case "MOVE":
    case "ATTACK":
      return `${action.kind}(${action.direction})`;
    case "USE_ITEM":
      return `${action.kind}(${action.itemId})`;
    case "WAIT":
      return "WAIT";
  }
}

function logLiveDecision(trace: LlmDecisionTrace): void {
  const base =
    `[LLM] turn=${trace.turn} action=${formatAction(trace.action)} ` +
    `latencyMs=${trace.latencyMs} tokens=${trace.tokenUsage.total}`;
  console.log(base);

  if (trace.decision?.whyThisAction) {
    console.log(`      why=${trace.decision.whyThisAction}`);
  }

  if (trace.fallbackReason) {
    console.log(`      fallback=${trace.fallbackReason}`);
  }
}

function createRunTimestamp(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

async function ensureDirectory(path: string): Promise<void> {
  const process = Bun.spawn(["mkdir", "-p", path], {
    stdout: "ignore",
    stderr: "pipe",
  });

  const exitCode = await process.exited;
  if (exitCode === 0) {
    return;
  }

  const stderr = await new Response(process.stderr).text();
  throw new Error(`Failed to create directory '${path}': ${stderr.trim()}`);
}

async function writeRunArtifact(params: {
  scenarioId: string;
  seed: number;
  reasoning: string;
  personaId: string;
  personaDescription: string;
  temperature: number;
  decisions: readonly LlmDecisionTrace[];
  result: Awaited<ReturnType<typeof runEpisode>>;
}): Promise<string> {
  const artifactDir = "artifacts/llm-runs";
  await ensureDirectory(artifactDir);

  const fileName = `${createRunTimestamp()}-${params.scenarioId}-seed-${params.seed}.json`;
  const artifactPath = `${artifactDir}/${fileName}`;
  const payload = {
    run: {
      createdAt: new Date().toISOString(),
      scenarioId: params.scenarioId,
      seed: params.seed,
      modelProvider: "openai-codex",
      modelId: "gpt-5.3-codex",
      reasoning: params.reasoning,
      temperature: params.temperature,
      persona: {
        id: params.personaId,
        description: params.personaDescription,
      },
    },
    result: {
      outcome: params.result.outcome,
      metrics: params.result.metrics,
    },
    decisions: params.decisions,
    simTrace: params.result.trace,
  };

  await Bun.write(artifactPath, `${JSON.stringify(payload, null, 2)}\n`);
  return artifactPath;
}

export async function main(): Promise<void> {
  const options = parseCliOptions(Bun.argv.slice(2));
  const seed = 42;
  const scenario = applyScenarioOverrides(createScenario(seed), options);
  const boardViewEnabled = !options.minimalLogs;
  let renderer: TerminalMapRenderer | undefined;
  const playerPolicy = new LlmCodexPolicy({
    reasoning: "low",
    personaId: options.personaId,
    onDecision: options.minimalLogs ? logLiveDecision : undefined,
    onEvent: boardViewEnabled ? (event) => renderer?.consumeLlmEvent(event) : undefined,
  });

  if (boardViewEnabled) {
    renderer = new TerminalMapRenderer(playerPolicy.getPersonaId());
  }

  const result = await (async () => {
    try {
      return await runEpisode({
        scenario,
        seed,
        playerPolicy,
        enemyController: new GreedyEnemyController(),
        traceEnabled: true,
        onEvent: renderer ? (event) => renderer.consume(event) : undefined,
      });
    } finally {
      renderer?.dispose();
    }
  })();

  console.log(`Scenario: ${result.scenarioId}`);
  console.log(`Seed: ${result.seed}`);
  console.log(`View: ${boardViewEnabled ? "board" : "llm-only"}`);
  console.log(`Persona: ${playerPolicy.getPersonaId()} - ${playerPolicy.getPersonaDescription()}`);
  console.log(`Temperature: ${playerPolicy.getTemperature()}`);
  console.log("");

  console.log("LLM Decisions:");
  for (const decision of playerPolicy.getDecisionTrace()) {
    console.log(
      `- turn=${decision.turn} action=${JSON.stringify(decision.action)} latencyMs=${decision.latencyMs} tokens=${decision.tokenUsage.total} stopReason=${decision.stopReason ?? "unknown"}`,
    );
    if (decision.decision?.whyThisAction) {
      console.log(`  why=${decision.decision.whyThisAction}`);
    }
    if (decision.decision?.confidence !== undefined) {
      console.log(`  confidence=${decision.decision.confidence}`);
    }
    if (decision.fallbackReason) {
      console.log(`  fallback=${decision.fallbackReason}`);
    }
    if (decision.decisionParseError) {
      console.log(`  decisionParseError=${decision.decisionParseError}`);
    }
    if (decision.modelErrorMessage) {
      console.log(`  modelError=${decision.modelErrorMessage}`);
    }
    if (decision.thinking.length > 0) {
      console.log(`  thinking=${JSON.stringify(decision.thinking)}`);
    }
    console.log(`  rawJson=${JSON.stringify(decision.rawJsonSnippet)}`);
  }
  console.log("");

  const artifactPath = await writeRunArtifact({
    scenarioId: scenario.id,
    seed,
    reasoning: playerPolicy.getReasoningLevel(),
    personaId: playerPolicy.getPersonaId(),
    personaDescription: playerPolicy.getPersonaDescription(),
    temperature: playerPolicy.getTemperature(),
    decisions: playerPolicy.getDecisionTrace(),
    result,
  });

  console.log(`Outcome: ${result.outcome}`);
  console.log(`Metrics: ${formatMetrics(result.metrics)}`);
  console.log(`Run artifact: ${artifactPath}`);
}

main().catch((error: unknown) => {
  console.error("Simulation run failed.");
  console.error(error);
  process.exit(1);
});
