import type { EnemyAction, EpisodeResult, GameState, Metrics, PlayerAction, SimulationEvent } from "./types.ts";

export type EpisodeEvent =
  | {
      type: "EPISODE_STARTED";
      scenarioId: string;
      seed: number;
      state: GameState;
    }
  | {
      type: "PLAYER_ACTION_REQUESTED";
      turn: number;
      playerId: number;
    }
  | {
      type: "PLAYER_ACTION_CHOSEN";
      turn: number;
      playerId: number;
      action: PlayerAction;
    }
  | {
      type: "PLAYER_ACTION_APPLIED";
      turn: number;
      playerId: number;
      action: PlayerAction;
      events: SimulationEvent[];
      state: GameState;
    }
  | {
      type: "ENEMY_ACTION_CHOSEN";
      turn: number;
      enemyId: number;
      action: EnemyAction;
    }
  | {
      type: "ENEMY_ACTION_APPLIED";
      turn: number;
      enemyId: number;
      action: EnemyAction;
      events: SimulationEvent[];
      state: GameState;
    }
  | {
      type: "TURN_FINALIZED";
      turn: number;
      events: SimulationEvent[];
      state: GameState;
    }
  | {
      type: "EPISODE_FINISHED";
      turn: number;
      outcome: EpisodeResult["outcome"];
      metrics: Metrics;
      state: GameState;
    };

export type EpisodeEventHandler = (event: EpisodeEvent) => void | Promise<void>;
