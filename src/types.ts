export type Tile = "FLOOR" | "WALL" | "EXIT";

export type Direction = "N" | "S" | "E" | "W";

export const DIRECTION_PRIORITY: readonly Direction[] = ["N", "S", "E", "W"];

export type ItemId = "potion";

export interface WaitAction {
  kind: "WAIT";
}

export interface MoveAction {
  kind: "MOVE";
  direction: Direction;
}

export interface AttackAction {
  kind: "ATTACK";
  direction: Direction;
}

export interface UseItemAction {
  kind: "USE_ITEM";
  itemId: ItemId;
}

export type PlayerAction = WaitAction | MoveAction | AttackAction | UseItemAction;
export type EnemyAction = WaitAction | MoveAction | AttackAction;
export type Action = PlayerAction | EnemyAction;

export interface Position {
  x: number;
  y: number;
}

export type ActorType = "player" | "enemy";

export interface ActorBase extends Position {
  id: number;
  hp: number;
  maxHp: number;
}

export interface Player extends ActorBase {
  kind: "player";
  potionCount: number;
  visitedPositions: Position[];
}

export interface Enemy extends ActorBase {
  kind: "enemy";
  attackDamage: number;
}

export interface MapGrid {
  width: number;
  height: number;
  tiles: Tile[][];
}

export interface SimulationRules {
  maxTurns: number;
  visionRadius: number;
  playerAttackDamage: number;
  potionHealAmount: number;
}

export interface Metrics {
  win: boolean;
  turnsSurvived: number;
  damageTaken: number;
  damageDealt: number;
  potionsUsed: number;
  enemiesKilled: number;
}

export type GameOutcome = "ONGOING" | "WIN" | "LOSS" | "TURN_LIMIT";

export interface GameState {
  seed: number;
  turn: number;
  map: MapGrid;
  players: Player[];
  enemies: Enemy[];
  rules: SimulationRules;
  metrics: Metrics;
  outcome: GameOutcome;
}

export interface ScenarioDefinition {
  id: string;
  description: string;
  map: MapGrid;
  players: Player[];
  enemies: Enemy[];
  rules: SimulationRules;
}

export interface ObservationTile extends Position {
  tile: Tile;
}

export interface ObservedEntity extends Position {
  id: number;
  kind: ActorType;
  hp: number;
  maxHp: number;
}

export interface ObservedSelf extends Position {
  id: number;
  hp: number;
  maxHp: number;
  potionCount: number;
}

export interface Observation {
  turn: number;
  self: ObservedSelf;
  visibleTiles: ObservationTile[];
  visibleEntities: ObservedEntity[];
  visitedPositions: Position[];
}

export interface PlayerActionIntent {
  playerId: number;
  action: PlayerAction;
}

export interface EnemyActionIntent {
  enemyId: number;
  action: EnemyAction;
}

export type InvalidActionReason =
  | "ACTOR_NOT_FOUND"
  | "ACTOR_DEAD"
  | "OUT_OF_BOUNDS"
  | "BLOCKED_BY_WALL"
  | "BLOCKED_BY_ENTITY"
  | "NO_TARGET"
  | "NO_POTION";

export interface ResolvedAction {
  actorType: ActorType;
  actorId: number;
  requestedAction: Action;
  appliedAction: Action;
  valid: boolean;
  invalidReason?: InvalidActionReason;
}

export type SimulationEvent =
  | {
      type: "ACTION_RESOLVED";
      data: ResolvedAction;
    }
  | {
      type: "MOVED";
      actorType: ActorType;
      actorId: number;
      from: Position;
      to: Position;
    }
  | {
      type: "ATTACK";
      attackerType: ActorType;
      attackerId: number;
      targetType: ActorType;
      targetId: number;
      damage: number;
      targetHpAfter: number;
    }
  | {
      type: "HEALED";
      actorType: "player";
      actorId: number;
      amount: number;
      hpAfter: number;
    }
  | {
      type: "DEATH";
      actorType: ActorType;
      actorId: number;
    }
  | {
      type: "TURN_FINALIZED";
      turn: number;
    }
  | {
      type: "OUTCOME_SET";
      outcome: Exclude<GameOutcome, "ONGOING">;
    };

export interface TransitionResult {
  state: GameState;
  events: SimulationEvent[];
}

export interface TurnTrace {
  turn: number;
  events: SimulationEvent[];
  board: string;
}

export interface EpisodeTrace {
  scenarioId: string;
  seed: number;
  turns: TurnTrace[];
}

export interface EpisodeResult {
  scenarioId: string;
  seed: number;
  outcome: Exclude<GameOutcome, "ONGOING">;
  metrics: Metrics;
  finalState: GameState;
  trace: EpisodeTrace;
}

export interface PlayerPolicy {
  chooseAction(observation: Observation): Promise<PlayerAction>;
}

export interface EnemyController {
  chooseAction(state: GameState, enemyId: number): EnemyAction;
}
