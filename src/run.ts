import { getObservation } from "./observation.ts";
import { render } from "./render.ts";
import {
  applyEnemyAction,
  applyPlayerPhase,
  createInitialState,
  finalizeTurn,
} from "./sim.ts";
import type {
  Action,
  ActorType,
  EnemyController,
  EpisodeResult,
  PlayerActionIntent,
  PlayerPolicy,
  ScenarioDefinition,
  SimulationEvent,
} from "./types.ts";

export type EpisodeStepPhase =
  | "TURN_START"
  | "PLAYER_ACTION_APPLIED"
  | "ENEMY_ACTION_APPLIED"
  | "TURN_FINALIZED";

export interface EpisodeStep {
  turn: number;
  phase: EpisodeStepPhase;
  actorType?: ActorType;
  actorId?: number;
  action?: Action;
  events: SimulationEvent[];
  board: string;
}

export interface RunEpisodeOptions {
  scenario: ScenarioDefinition;
  seed: number;
  playerPolicy: PlayerPolicy;
  enemyController: EnemyController;
  traceEnabled?: boolean;
  onStep?: (step: EpisodeStep) => void | Promise<void>;
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

async function emitEpisodeStep(
  options: RunEpisodeOptions,
  step: EpisodeStep,
): Promise<void> {
  if (!options.onStep) {
    return;
  }

  await options.onStep(step);
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

    await emitEpisodeStep(options, {
      turn: turnNumber,
      phase: "TURN_START",
      events: [],
      board: render(state),
    });

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

    for (const playerIntent of playerIntents) {
      const playerPhaseResult = applyPlayerPhase(state, [playerIntent]);
      state = playerPhaseResult.state;
      turnEvents.push(...playerPhaseResult.events);

      await emitEpisodeStep(options, {
        turn: turnNumber,
        phase: "PLAYER_ACTION_APPLIED",
        actorType: "player",
        actorId: playerIntent.playerId,
        action: playerIntent.action,
        events: playerPhaseResult.events,
        board: render(state),
      });
    }

    const aliveEnemies = sortById(state.enemies.filter((enemy) => enemy.hp > 0));

    for (const enemy of aliveEnemies) {
      const enemyAction = options.enemyController.chooseAction(state, enemy.id);
      const enemyResult = applyEnemyAction(state, enemy.id, enemyAction);
      state = enemyResult.state;
      turnEvents.push(...enemyResult.events);

      await emitEpisodeStep(options, {
        turn: turnNumber,
        phase: "ENEMY_ACTION_APPLIED",
        actorType: "enemy",
        actorId: enemy.id,
        action: enemyAction,
        events: enemyResult.events,
        board: render(state),
      });
    }

    const finalizationResult = finalizeTurn(state);
    state = finalizationResult.state;
    turnEvents.push(...finalizationResult.events);

    const finalizedBoard = render(state);

    await emitEpisodeStep(options, {
      turn: turnNumber,
      phase: "TURN_FINALIZED",
      events: finalizationResult.events,
      board: finalizedBoard,
    });

    if (traceEnabled) {
      trace.turns.push({
        turn: turnNumber,
        events: turnEvents,
        board: finalizedBoard,
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
      onStep: options.onStep,
    });
    results.push(result);
  }

  return results;
}
