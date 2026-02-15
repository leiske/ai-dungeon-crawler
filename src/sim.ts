import {
  isAttackAction,
  isMoveAction,
  isUseItemAction,
  WAIT_ACTION,
} from "./action-utils.ts";
import { DIRECTION_DELTAS, isInBounds, isOccupiedByAliveEntity, isWall } from "./spatial.ts";
import type {
  Action,
  ActorType,
  Enemy,
  EnemyAction,
  EnemyActionIntent,
  GameOutcome,
  GameState,
  InvalidActionReason,
  Metrics,
  Player,
  PlayerActionIntent,
  ScenarioDefinition,
  TransitionResult,
} from "./types.ts";

type EventList = TransitionResult["events"];

interface MutableActorPosition {
  id: number;
  x: number;
  y: number;
}

interface ResolveActionEventInput {
  actorType: ActorType;
  actorId: number;
  requestedAction: Action;
  appliedAction: Action;
  valid: boolean;
  invalidReason?: InvalidActionReason;
}

function pushResolvedActionEvent(events: EventList, input: ResolveActionEventInput): void {
  events.push({
    type: "ACTION_RESOLVED",
    data: {
      actorType: input.actorType,
      actorId: input.actorId,
      requestedAction: input.requestedAction,
      appliedAction: input.appliedAction,
      valid: input.valid,
      invalidReason: input.invalidReason,
    },
  });
}

interface MoveActorInput {
  state: GameState;
  events: EventList;
  actorType: ActorType;
  actor: MutableActorPosition;
  requestedAction: Action;
  ignoreEnemyId?: number;
  ignorePlayerId?: number;
}

function tryApplyMoveAction(input: MoveActorInput): boolean {
  if (!isMoveAction(input.requestedAction)) {
    return false;
  }

  const delta = DIRECTION_DELTAS[input.requestedAction.direction];
  const targetX = input.actor.x + delta.dx;
  const targetY = input.actor.y + delta.dy;

  if (!isInBounds(input.state, targetX, targetY)) {
    pushResolvedActionEvent(input.events, {
      actorType: input.actorType,
      actorId: input.actor.id,
      requestedAction: input.requestedAction,
      appliedAction: WAIT_ACTION,
      valid: false,
      invalidReason: "OUT_OF_BOUNDS",
    });
    return true;
  }

  if (isWall(input.state, targetX, targetY)) {
    pushResolvedActionEvent(input.events, {
      actorType: input.actorType,
      actorId: input.actor.id,
      requestedAction: input.requestedAction,
      appliedAction: WAIT_ACTION,
      valid: false,
      invalidReason: "BLOCKED_BY_WALL",
    });
    return true;
  }

  if (
    isOccupiedByAliveEntity(input.state, targetX, targetY, {
      ignoreEnemyId: input.ignoreEnemyId,
      ignorePlayerId: input.ignorePlayerId,
    })
  ) {
    pushResolvedActionEvent(input.events, {
      actorType: input.actorType,
      actorId: input.actor.id,
      requestedAction: input.requestedAction,
      appliedAction: WAIT_ACTION,
      valid: false,
      invalidReason: "BLOCKED_BY_ENTITY",
    });
    return true;
  }

  const fromX = input.actor.x;
  const fromY = input.actor.y;
  input.actor.x = targetX;
  input.actor.y = targetY;

  pushResolvedActionEvent(input.events, {
    actorType: input.actorType,
    actorId: input.actor.id,
    requestedAction: input.requestedAction,
    appliedAction: input.requestedAction,
    valid: true,
  });

  input.events.push({
    type: "MOVED",
    actorType: input.actorType,
    actorId: input.actor.id,
    from: { x: fromX, y: fromY },
    to: { x: targetX, y: targetY },
  });

  return true;
}

function clonePlayers(players: Player[]): Player[] {
  return players.map((player) => ({ ...player }));
}

function cloneEnemies(enemies: Enemy[]): Enemy[] {
  return enemies.map((enemy) => ({ ...enemy }));
}

function createInitialMetrics(): Metrics {
  return {
    win: false,
    turnsSurvived: 0,
    damageTaken: 0,
    damageDealt: 0,
    potionsUsed: 0,
    enemiesKilled: 0,
  };
}

export function cloneState(state: GameState): GameState {
  return {
    seed: state.seed,
    turn: state.turn,
    map: {
      width: state.map.width,
      height: state.map.height,
      tiles: state.map.tiles.map((row) => [...row]),
    },
    players: clonePlayers(state.players),
    enemies: cloneEnemies(state.enemies),
    rules: {
      maxTurns: state.rules.maxTurns,
      visionRadius: state.rules.visionRadius,
      playerAttackDamage: state.rules.playerAttackDamage,
      potionHealAmount: state.rules.potionHealAmount,
    },
    metrics: {
      win: state.metrics.win,
      turnsSurvived: state.metrics.turnsSurvived,
      damageTaken: state.metrics.damageTaken,
      damageDealt: state.metrics.damageDealt,
      potionsUsed: state.metrics.potionsUsed,
      enemiesKilled: state.metrics.enemiesKilled,
    },
    outcome: state.outcome,
  };
}

export function createInitialState(
  scenario: ScenarioDefinition,
  seed: number,
): GameState {
  return {
    seed,
    turn: 0,
    map: {
      width: scenario.map.width,
      height: scenario.map.height,
      tiles: scenario.map.tiles.map((row) => [...row]),
    },
    players: clonePlayers(scenario.players),
    enemies: cloneEnemies(scenario.enemies),
    rules: {
      maxTurns: scenario.rules.maxTurns,
      visionRadius: scenario.rules.visionRadius,
      playerAttackDamage: scenario.rules.playerAttackDamage,
      potionHealAmount: scenario.rules.potionHealAmount,
    },
    metrics: createInitialMetrics(),
    outcome: "ONGOING",
  };
}

export function applyPlayerPhase(
  state: GameState,
  playerIntents: PlayerActionIntent[],
): TransitionResult {
  const nextState = cloneState(state);
  const events: EventList = [];

  const sortedIntents = [...playerIntents].sort((a, b) => a.playerId - b.playerId);

  for (const intent of sortedIntents) {
    const player = nextState.players.find((candidate) => candidate.id === intent.playerId);

    if (!player) {
      pushResolvedActionEvent(events, {
        actorType: "player",
        actorId: intent.playerId,
        requestedAction: intent.action,
        appliedAction: WAIT_ACTION,
        valid: false,
        invalidReason: "ACTOR_NOT_FOUND",
      });
      continue;
    }

    if (player.hp <= 0) {
      pushResolvedActionEvent(events, {
        actorType: "player",
        actorId: player.id,
        requestedAction: intent.action,
        appliedAction: WAIT_ACTION,
        valid: false,
        invalidReason: "ACTOR_DEAD",
      });
      continue;
    }

    if (intent.action.kind === "WAIT") {
      pushResolvedActionEvent(events, {
        actorType: "player",
        actorId: player.id,
        requestedAction: intent.action,
        appliedAction: WAIT_ACTION,
        valid: true,
      });
      continue;
    }

    if (
      tryApplyMoveAction({
        state: nextState,
        events,
        actorType: "player",
        actor: player,
        requestedAction: intent.action,
        ignorePlayerId: player.id,
      })
    ) {
      continue;
    }

    if (isAttackAction(intent.action)) {
      const delta = DIRECTION_DELTAS[intent.action.direction];
      const targetX = player.x + delta.dx;
      const targetY = player.y + delta.dy;

      if (!isInBounds(nextState, targetX, targetY)) {
        pushResolvedActionEvent(events, {
          actorType: "player",
          actorId: player.id,
          requestedAction: intent.action,
          appliedAction: WAIT_ACTION,
          valid: false,
          invalidReason: "OUT_OF_BOUNDS",
        });
        continue;
      }

      const targetEnemy = nextState.enemies.find(
        (enemy) => enemy.hp > 0 && enemy.x === targetX && enemy.y === targetY,
      );

      if (!targetEnemy) {
        pushResolvedActionEvent(events, {
          actorType: "player",
          actorId: player.id,
          requestedAction: intent.action,
          appliedAction: WAIT_ACTION,
          valid: false,
          invalidReason: "NO_TARGET",
        });
        continue;
      }

      const damage = Math.min(nextState.rules.playerAttackDamage, targetEnemy.hp);
      targetEnemy.hp -= damage;
      nextState.metrics.damageDealt += damage;

      pushResolvedActionEvent(events, {
        actorType: "player",
        actorId: player.id,
        requestedAction: intent.action,
        appliedAction: intent.action,
        valid: true,
      });

      events.push({
        type: "ATTACK",
        attackerType: "player",
        attackerId: player.id,
        targetType: "enemy",
        targetId: targetEnemy.id,
        damage,
        targetHpAfter: targetEnemy.hp,
      });

      if (targetEnemy.hp <= 0) {
        nextState.metrics.enemiesKilled += 1;
        events.push({
          type: "DEATH",
          actorType: "enemy",
          actorId: targetEnemy.id,
        });
      }
      continue;
    }

    if (isUseItemAction(intent.action)) {
      if (intent.action.itemId !== "potion") {
        pushResolvedActionEvent(events, {
          actorType: "player",
          actorId: player.id,
          requestedAction: intent.action,
          appliedAction: WAIT_ACTION,
          valid: false,
          invalidReason: "NO_POTION",
        });
        continue;
      }

      if (player.potionCount <= 0) {
        pushResolvedActionEvent(events, {
          actorType: "player",
          actorId: player.id,
          requestedAction: intent.action,
          appliedAction: WAIT_ACTION,
          valid: false,
          invalidReason: "NO_POTION",
        });
        continue;
      }

      player.potionCount -= 1;
      const healAmount = Math.min(nextState.rules.potionHealAmount, player.maxHp - player.hp);
      player.hp += healAmount;
      nextState.metrics.potionsUsed += 1;

      pushResolvedActionEvent(events, {
        actorType: "player",
        actorId: player.id,
        requestedAction: intent.action,
        appliedAction: intent.action,
        valid: true,
      });

      events.push({
        type: "HEALED",
        actorType: "player",
        actorId: player.id,
        amount: healAmount,
        hpAfter: player.hp,
      });
      continue;
    }

    pushResolvedActionEvent(events, {
      actorType: "player",
      actorId: player.id,
      requestedAction: intent.action,
      appliedAction: WAIT_ACTION,
      valid: false,
      invalidReason: "NO_TARGET",
    });
  }

  return {
    state: nextState,
    events,
  };
}

function applyEnemyIntentToDraft(
  draftState: GameState,
  events: EventList,
  intent: EnemyActionIntent,
): void {
  const enemy = draftState.enemies.find((candidate) => candidate.id === intent.enemyId);

  if (!enemy) {
    pushResolvedActionEvent(events, {
      actorType: "enemy",
      actorId: intent.enemyId,
      requestedAction: intent.action,
      appliedAction: WAIT_ACTION,
      valid: false,
      invalidReason: "ACTOR_NOT_FOUND",
    });
    return;
  }

  if (enemy.hp <= 0) {
    pushResolvedActionEvent(events, {
      actorType: "enemy",
      actorId: enemy.id,
      requestedAction: intent.action,
      appliedAction: WAIT_ACTION,
      valid: false,
      invalidReason: "ACTOR_DEAD",
    });
    return;
  }

  if (intent.action.kind === "WAIT") {
    pushResolvedActionEvent(events, {
      actorType: "enemy",
      actorId: enemy.id,
      requestedAction: intent.action,
      appliedAction: WAIT_ACTION,
      valid: true,
    });
    return;
  }

  if (
    tryApplyMoveAction({
      state: draftState,
      events,
      actorType: "enemy",
      actor: enemy,
      requestedAction: intent.action,
      ignoreEnemyId: enemy.id,
    })
  ) {
    return;
  }

  if (isAttackAction(intent.action)) {
    const delta = DIRECTION_DELTAS[intent.action.direction];
    const targetX = enemy.x + delta.dx;
    const targetY = enemy.y + delta.dy;

    if (!isInBounds(draftState, targetX, targetY)) {
      pushResolvedActionEvent(events, {
        actorType: "enemy",
        actorId: enemy.id,
        requestedAction: intent.action,
        appliedAction: WAIT_ACTION,
        valid: false,
        invalidReason: "OUT_OF_BOUNDS",
      });
      return;
    }

    const targetPlayer = draftState.players.find(
      (player) => player.hp > 0 && player.x === targetX && player.y === targetY,
    );

    if (!targetPlayer) {
      pushResolvedActionEvent(events, {
        actorType: "enemy",
        actorId: enemy.id,
        requestedAction: intent.action,
        appliedAction: WAIT_ACTION,
        valid: false,
        invalidReason: "NO_TARGET",
      });
      return;
    }

    const damage = Math.min(enemy.attackDamage, targetPlayer.hp);
    targetPlayer.hp -= damage;
    draftState.metrics.damageTaken += damage;

    pushResolvedActionEvent(events, {
      actorType: "enemy",
      actorId: enemy.id,
      requestedAction: intent.action,
      appliedAction: intent.action,
      valid: true,
    });

    events.push({
      type: "ATTACK",
      attackerType: "enemy",
      attackerId: enemy.id,
      targetType: "player",
      targetId: targetPlayer.id,
      damage,
      targetHpAfter: targetPlayer.hp,
    });

    if (targetPlayer.hp <= 0) {
      events.push({
        type: "DEATH",
        actorType: "player",
        actorId: targetPlayer.id,
      });
    }

    return;
  }

  pushResolvedActionEvent(events, {
    actorType: "enemy",
    actorId: enemy.id,
    requestedAction: intent.action,
    appliedAction: WAIT_ACTION,
    valid: false,
    invalidReason: "NO_TARGET",
  });
}

export function applyEnemyAction(
  state: GameState,
  enemyId: number,
  action: EnemyAction,
): TransitionResult {
  const nextState = cloneState(state);
  const events: EventList = [];

  applyEnemyIntentToDraft(nextState, events, {
    enemyId,
    action,
  });

  return {
    state: nextState,
    events,
  };
}

function computeOutcome(state: GameState): GameOutcome {
  const alivePlayers = state.players.filter((player) => player.hp > 0);
  if (alivePlayers.length === 0) {
    return "LOSS";
  }

  const alivePlayerOnExit = alivePlayers.some((player) => {
    const row = state.map.tiles[player.y];
    const tile = row?.[player.x];
    return tile === "EXIT";
  });

  if (alivePlayerOnExit) {
    return "WIN";
  }

  if (state.turn >= state.rules.maxTurns) {
    return "TURN_LIMIT";
  }

  return "ONGOING";
}

export function finalizeTurn(state: GameState): TransitionResult {
  const nextState = cloneState(state);
  const events: EventList = [];

  nextState.turn += 1;
  nextState.metrics.turnsSurvived = nextState.turn;

  events.push({
    type: "TURN_FINALIZED",
    turn: nextState.turn,
  });

  const outcome = computeOutcome(nextState);
  nextState.outcome = outcome;
  nextState.metrics.win = outcome === "WIN";

  if (outcome !== "ONGOING") {
    events.push({
      type: "OUTCOME_SET",
      outcome,
    });
  }

  return {
    state: nextState,
    events,
  };
}
