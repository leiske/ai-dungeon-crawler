import { getObservation } from "./observation.ts";
import { render } from "./render.ts";
import {
  applyEnemyAction,
  applyPlayerPhase,
  createInitialState,
  finalizeTurn,
} from "./sim.ts";
import type {
  EnemyController,
  EpisodeResult,
  PlayerActionIntent,
  PlayerPolicy,
  ScenarioDefinition,
  SimulationEvent,
} from "./types.ts";

export interface RunEpisodeOptions {
  scenario: ScenarioDefinition;
  seed: number;
  playerPolicy: PlayerPolicy;
  enemyController: EnemyController;
  traceEnabled?: boolean;
}

function assertTerminalOutcome(
  outcome: EpisodeResult["outcome"] | "ONGOING",
): EpisodeResult["outcome"] {
  if (outcome === "ONGOING") {
    throw new Error("Episode ended without terminal outcome.");
  }
  return outcome;
}

function sortById<T extends { id: number }>(items: T[]): T[] {
  return [...items].sort((a, b) => a.id - b.id);
}

export async function runEpisode(options: RunEpisodeOptions): Promise<EpisodeResult> {
  const traceEnabled = options.traceEnabled ?? true;
  let state = createInitialState(options.scenario, options.seed);

  const trace: EpisodeResult["trace"] = {
    scenarioId: options.scenario.id,
    seed: options.seed,
    turns: [],
  };

  while (state.outcome === "ONGOING") {
    const turnEvents: SimulationEvent[] = [];
    const turnNumber = state.turn;

    const alivePlayers = sortById(state.players.filter((player) => player.hp > 0));
    const playerIntents: PlayerActionIntent[] = [];

    for (const player of alivePlayers) {
      const observation = getObservation(state, player.id);
      const action = await options.playerPolicy.chooseAction(observation);
      playerIntents.push({
        playerId: player.id,
        action,
      });
    }

    const playerPhaseResult = applyPlayerPhase(state, playerIntents);
    state = playerPhaseResult.state;
    turnEvents.push(...playerPhaseResult.events);

    const aliveEnemies = sortById(state.enemies.filter((enemy) => enemy.hp > 0));

    for (const enemy of aliveEnemies) {
      const enemyAction = options.enemyController.chooseAction(state, enemy.id);
      const enemyResult = applyEnemyAction(state, enemy.id, enemyAction);
      state = enemyResult.state;
      turnEvents.push(...enemyResult.events);
    }

    const finalizationResult = finalizeTurn(state);
    state = finalizationResult.state;
    turnEvents.push(...finalizationResult.events);

    if (traceEnabled) {
      trace.turns.push({
        turn: turnNumber,
        events: turnEvents,
        board: render(state),
      });
    }
  }

  return {
    scenarioId: options.scenario.id,
    seed: options.seed,
    outcome: assertTerminalOutcome(state.outcome),
    metrics: {
      win: state.metrics.win,
      turnsSurvived: state.metrics.turnsSurvived,
      damageTaken: state.metrics.damageTaken,
      damageDealt: state.metrics.damageDealt,
      potionsUsed: state.metrics.potionsUsed,
      enemiesKilled: state.metrics.enemiesKilled,
    },
    finalState: state,
    trace,
  };
}

export async function runEpisodes(
  options: Omit<RunEpisodeOptions, "seed"> & { seeds: number[] },
): Promise<EpisodeResult[]> {
  const results: EpisodeResult[] = [];

  for (const seed of options.seeds) {
    const result = await runEpisode({
      scenario: options.scenario,
      seed,
      playerPolicy: options.playerPolicy,
      enemyController: options.enemyController,
      traceEnabled: options.traceEnabled,
    });
    results.push(result);
  }

  return results;
}
