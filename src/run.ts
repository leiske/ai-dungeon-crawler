import { getObservation } from "./observation.ts";
import type { EpisodeEvent, EpisodeEventHandler } from "./episode-events.ts";
import {
  applyEnemyAction,
  applyPlayerPhase,
  cloneState,
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

const ENEMY_THINK_DELAY_MS = 250;

export interface RunEpisodeOptions {
  scenario: ScenarioDefinition;
  seed: number;
  playerPolicy: PlayerPolicy;
  enemyController: EnemyController;
  traceEnabled?: boolean;
  onEvent?: EpisodeEventHandler;
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

async function emitEpisodeEvent(
  options: RunEpisodeOptions,
  event: EpisodeEvent,
): Promise<void> {
  if (!options.onEvent) {
    return;
  }

  await options.onEvent(event);
}

export async function runEpisode(options: RunEpisodeOptions): Promise<EpisodeResult> {
  const traceEnabled = options.traceEnabled ?? true;
  let state = createInitialState(options.scenario, options.seed);

  const trace: EpisodeResult["trace"] = {
    scenarioId: options.scenario.id,
    seed: options.seed,
    turns: [],
  };

  await emitEpisodeEvent(options, {
    type: "EPISODE_STARTED",
    scenarioId: options.scenario.id,
    seed: options.seed,
    state: cloneState(state),
  });

  while (state.outcome === "ONGOING") {
    const turnEvents: SimulationEvent[] = [];
    const turnNumber = state.turn;

    const alivePlayers = sortById(state.players.filter((player) => player.hp > 0));
    const playerIntents: PlayerActionIntent[] = [];

    for (const player of alivePlayers) {
      await emitEpisodeEvent(options, {
        type: "PLAYER_ACTION_REQUESTED",
        turn: turnNumber,
        playerId: player.id,
      });

      const observation = getObservation(state, player.id);
      const action = await options.playerPolicy.chooseAction(observation);

      await emitEpisodeEvent(options, {
        type: "PLAYER_ACTION_CHOSEN",
        turn: turnNumber,
        playerId: player.id,
        action,
      });

      playerIntents.push({
        playerId: player.id,
        action,
      });
    }

    for (const playerIntent of playerIntents) {
      const playerPhaseResult = applyPlayerPhase(state, [playerIntent]);
      state = playerPhaseResult.state;
      turnEvents.push(...playerPhaseResult.events);

      await emitEpisodeEvent(options, {
        type: "PLAYER_ACTION_APPLIED",
        turn: turnNumber,
        playerId: playerIntent.playerId,
        action: playerIntent.action,
        events: playerPhaseResult.events,
        state: cloneState(state),
      });
    }

    const aliveEnemies = sortById(state.enemies.filter((enemy) => enemy.hp > 0));

    for (const enemy of aliveEnemies) {
      await Bun.sleep(ENEMY_THINK_DELAY_MS);

      const enemyAction = options.enemyController.chooseAction(state, enemy.id);

      await emitEpisodeEvent(options, {
        type: "ENEMY_ACTION_CHOSEN",
        turn: turnNumber,
        enemyId: enemy.id,
        action: enemyAction,
      });

      const enemyResult = applyEnemyAction(state, enemy.id, enemyAction);
      state = enemyResult.state;
      turnEvents.push(...enemyResult.events);

      await emitEpisodeEvent(options, {
        type: "ENEMY_ACTION_APPLIED",
        turn: turnNumber,
        enemyId: enemy.id,
        action: enemyAction,
        events: enemyResult.events,
        state: cloneState(state),
      });
    }

    const finalizationResult = finalizeTurn(state);
    state = finalizationResult.state;
    turnEvents.push(...finalizationResult.events);

    await emitEpisodeEvent(options, {
      type: "TURN_FINALIZED",
      turn: state.turn,
      events: finalizationResult.events,
      state: cloneState(state),
    });

    if (traceEnabled) {
      trace.turns.push({
        turn: turnNumber,
        events: turnEvents,
      });
    }
  }

  const outcome = assertTerminalOutcome(state.outcome);
  const metrics = {
    win: state.metrics.win,
    turnsSurvived: state.metrics.turnsSurvived,
    damageTaken: state.metrics.damageTaken,
    damageDealt: state.metrics.damageDealt,
    potionsUsed: state.metrics.potionsUsed,
    enemiesKilled: state.metrics.enemiesKilled,
  };

  await emitEpisodeEvent(options, {
    type: "EPISODE_FINISHED",
    turn: state.turn,
    outcome,
    metrics,
    state: cloneState(state),
  });

  return {
    scenarioId: options.scenario.id,
    seed: options.seed,
    outcome,
    metrics,
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
      onEvent: options.onEvent,
    });
    results.push(result);
  }

  return results;
}
