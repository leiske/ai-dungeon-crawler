import { GreedyEnemyController } from "./src/enemy/greedy.ts";
import { WaitPolicy } from "./src/policy/stub.ts";
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

export async function main(): Promise<void> {
  const seed = 42;
  const scenario = createScenario(seed);

  const result = await runEpisode({
    scenario,
    seed,
    playerPolicy: new WaitPolicy(),
    enemyController: new GreedyEnemyController(),
    traceEnabled: true,
  });

  console.log(`Scenario: ${result.scenarioId}`);
  console.log(`Seed: ${result.seed}`);
  console.log("");

  for (const turn of result.trace.turns) {
    console.log(`Turn ${turn.turn}`);
    console.log(turn.board);
    console.log("Events:");
    for (const event of turn.events) {
      console.log(`- ${JSON.stringify(event)}`);
    }
    console.log("");
  }

  console.log(`Outcome: ${result.outcome}`);
  console.log(`Metrics: ${formatMetrics(result.metrics)}`);
}

main().catch((error: unknown) => {
  console.error("Simulation run failed.");
  console.error(error);
  process.exit(1);
});
