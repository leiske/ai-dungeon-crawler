import { GreedyEnemyController } from "./src/enemy/greedy.ts";
import { LlmCodexPolicy } from "./src/policy/llm.ts";
import type { EpisodeStep } from "./src/run.ts";
import { runEpisode } from "./src/run.ts";
import { createScenario } from "./src/scenario.ts";

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

function formatStepHeader(step: EpisodeStep): string {
  if (step.phase === "TURN_START") {
    return `Turn ${step.turn} | TURN_START`;
  }

  if (step.phase === "TURN_FINALIZED") {
    return `Turn ${step.turn} | TURN_FINALIZED`;
  }

  return `Turn ${step.turn} | ${step.phase} | ${step.actorType ?? "unknown"}#${step.actorId ?? "unknown"} | action=${JSON.stringify(step.action)}`;
}

function printStep(step: EpisodeStep): void {
  console.log(formatStepHeader(step));
  console.log(step.board);
  console.log("Events:");
  if (step.events.length === 0) {
    console.log("- none");
  } else {
    for (const event of step.events) {
      console.log(`- ${JSON.stringify(event)}`);
    }
  }
  console.log("");
}

export async function main(): Promise<void> {
  const seed = 42;
  const scenario = createScenario(seed);
  const playerPolicy = new LlmCodexPolicy();

  const result = await runEpisode({
    scenario,
    seed,
    playerPolicy,
    enemyController: new GreedyEnemyController(),
    traceEnabled: true,
    onStep: printStep,
  });

  console.log(`Scenario: ${result.scenarioId}`);
  console.log(`Seed: ${result.seed}`);
  console.log("");

  console.log("LLM Decisions:");
  for (const decision of playerPolicy.getDecisionTrace()) {
    console.log(
      `- turn=${decision.turn} action=${JSON.stringify(decision.action)} latencyMs=${decision.latencyMs} tokens=${decision.tokenUsage.total} stopReason=${decision.stopReason ?? "unknown"}`,
    );
    if (decision.fallbackReason) {
      console.log(`  fallback=${decision.fallbackReason}`);
    }
    if (decision.modelErrorMessage) {
      console.log(`  modelError=${decision.modelErrorMessage}`);
    }
    console.log(`  raw=${JSON.stringify(decision.rawResponse)}`);
  }
  console.log("");

  console.log(`Outcome: ${result.outcome}`);
  console.log(`Metrics: ${formatMetrics(result.metrics)}`);
}

main().catch((error: unknown) => {
  console.error("Simulation run failed.");
  console.error(error);
  process.exit(1);
});
