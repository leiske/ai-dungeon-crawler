import type {
  Enemy,
  EnemyAction,
  GameState,
  GameOutcome,
  Metrics,
  Player,
  PlayerActionIntent,
  ScenarioDefinition,
  TransitionResult,
} from "./types.ts";
import { parseAttackDirection, parseMoveDirection } from "./action-utils.ts";
import { DIRECTION_DELTAS, isInBounds, isOccupiedByAliveEntity, isWall } from "./spatial.ts";

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
  const events: TransitionResult["events"] = [];

  const sortedIntents = [...playerIntents].sort((a, b) => a.playerId - b.playerId);

  for (const intent of sortedIntents) {
    const player = nextState.players.find((candidate) => candidate.id === intent.playerId);

    if (!player) {
      events.push({
        type: "ACTION_RESOLVED",
        data: {
          actorType: "player",
          actorId: intent.playerId,
          requestedAction: intent.action,
          appliedAction: "WAIT",
          valid: false,
          invalidReason: "ACTOR_NOT_FOUND",
        },
      });
      continue;
    }

    if (player.hp <= 0) {
      events.push({
        type: "ACTION_RESOLVED",
        data: {
          actorType: "player",
          actorId: player.id,
          requestedAction: intent.action,
          appliedAction: "WAIT",
          valid: false,
          invalidReason: "ACTOR_DEAD",
        },
      });
      continue;
    }

    if (intent.action === "WAIT") {
      events.push({
        type: "ACTION_RESOLVED",
        data: {
          actorType: "player",
          actorId: player.id,
          requestedAction: intent.action,
          appliedAction: "WAIT",
          valid: true,
        },
      });
      continue;
    }

    const moveDirection = parseMoveDirection(intent.action);
    if (moveDirection) {
      const delta = DIRECTION_DELTAS[moveDirection];
      const targetX = player.x + delta.dx;
      const targetY = player.y + delta.dy;

      if (!isInBounds(nextState, targetX, targetY)) {
        events.push({
          type: "ACTION_RESOLVED",
          data: {
            actorType: "player",
            actorId: player.id,
            requestedAction: intent.action,
            appliedAction: "WAIT",
            valid: false,
            invalidReason: "OUT_OF_BOUNDS",
          },
        });
        continue;
      }

      if (isWall(nextState, targetX, targetY)) {
        events.push({
          type: "ACTION_RESOLVED",
          data: {
            actorType: "player",
            actorId: player.id,
            requestedAction: intent.action,
            appliedAction: "WAIT",
            valid: false,
            invalidReason: "BLOCKED_BY_WALL",
          },
        });
        continue;
      }

      if (isOccupiedByAliveEntity(nextState, targetX, targetY, { ignorePlayerId: player.id })) {
        events.push({
          type: "ACTION_RESOLVED",
          data: {
            actorType: "player",
            actorId: player.id,
            requestedAction: intent.action,
            appliedAction: "WAIT",
            valid: false,
            invalidReason: "BLOCKED_BY_ENTITY",
          },
        });
        continue;
      }

      const fromX = player.x;
      const fromY = player.y;
      player.x = targetX;
      player.y = targetY;

      events.push({
        type: "ACTION_RESOLVED",
        data: {
          actorType: "player",
          actorId: player.id,
          requestedAction: intent.action,
          appliedAction: intent.action,
          valid: true,
        },
      });

      events.push({
        type: "MOVED",
        actorType: "player",
        actorId: player.id,
        from: { x: fromX, y: fromY },
        to: { x: targetX, y: targetY },
      });
      continue;
    }

    const attackDirection = parseAttackDirection(intent.action);
    if (attackDirection) {
      const delta = DIRECTION_DELTAS[attackDirection];
      const targetX = player.x + delta.dx;
      const targetY = player.y + delta.dy;

      if (!isInBounds(nextState, targetX, targetY)) {
        events.push({
          type: "ACTION_RESOLVED",
          data: {
            actorType: "player",
            actorId: player.id,
            requestedAction: intent.action,
            appliedAction: "WAIT",
            valid: false,
            invalidReason: "OUT_OF_BOUNDS",
          },
        });
        continue;
      }

      const targetEnemy = nextState.enemies.find(
        (enemy) => enemy.hp > 0 && enemy.x === targetX && enemy.y === targetY,
      );

      if (!targetEnemy) {
        events.push({
          type: "ACTION_RESOLVED",
          data: {
            actorType: "player",
            actorId: player.id,
            requestedAction: intent.action,
            appliedAction: "WAIT",
            valid: false,
            invalidReason: "NO_TARGET",
          },
        });
        continue;
      }

      const damage = Math.min(nextState.rules.playerAttackDamage, targetEnemy.hp);
      targetEnemy.hp -= damage;
      nextState.metrics.damageDealt += damage;

      events.push({
        type: "ACTION_RESOLVED",
        data: {
          actorType: "player",
          actorId: player.id,
          requestedAction: intent.action,
          appliedAction: intent.action,
          valid: true,
        },
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

    if (intent.action === "USE_POTION") {
      if (player.potionCount <= 0) {
        events.push({
          type: "ACTION_RESOLVED",
          data: {
            actorType: "player",
            actorId: player.id,
            requestedAction: intent.action,
            appliedAction: "WAIT",
            valid: false,
            invalidReason: "NO_POTION",
          },
        });
        continue;
      }

      player.potionCount -= 1;
      const healAmount = Math.min(nextState.rules.potionHealAmount, player.maxHp - player.hp);
      player.hp += healAmount;
      nextState.metrics.potionsUsed += 1;

      events.push({
        type: "ACTION_RESOLVED",
        data: {
          actorType: "player",
          actorId: player.id,
          requestedAction: intent.action,
          appliedAction: intent.action,
          valid: true,
        },
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

    events.push({
      type: "ACTION_RESOLVED",
      data: {
        actorType: "player",
        actorId: player.id,
        requestedAction: intent.action,
        appliedAction: "WAIT",
        valid: false,
        invalidReason: "NO_TARGET",
      },
    });
  }

  return {
    state: nextState,
    events,
  };
}

export function applyEnemyAction(
  state: GameState,
  enemyId: number,
  action: EnemyAction,
): TransitionResult {
  const nextState = cloneState(state);
  const events: TransitionResult["events"] = [];

  const enemy = nextState.enemies.find((candidate) => candidate.id === enemyId);

  if (!enemy) {
    events.push({
      type: "ACTION_RESOLVED",
      data: {
        actorType: "enemy",
        actorId: enemyId,
        requestedAction: action,
        appliedAction: "WAIT",
        valid: false,
        invalidReason: "ACTOR_NOT_FOUND",
      },
    });
    return { state: nextState, events };
  }

  if (enemy.hp <= 0) {
    events.push({
      type: "ACTION_RESOLVED",
      data: {
        actorType: "enemy",
        actorId: enemy.id,
        requestedAction: action,
        appliedAction: "WAIT",
        valid: false,
        invalidReason: "ACTOR_DEAD",
      },
    });
    return { state: nextState, events };
  }

  if (action === "WAIT") {
    events.push({
      type: "ACTION_RESOLVED",
      data: {
        actorType: "enemy",
        actorId: enemy.id,
        requestedAction: action,
        appliedAction: "WAIT",
        valid: true,
      },
    });
    return { state: nextState, events };
  }

  const moveDirection = parseMoveDirection(action);
  if (moveDirection) {
    const delta = DIRECTION_DELTAS[moveDirection];
    const targetX = enemy.x + delta.dx;
    const targetY = enemy.y + delta.dy;

    if (!isInBounds(nextState, targetX, targetY)) {
      events.push({
        type: "ACTION_RESOLVED",
        data: {
          actorType: "enemy",
          actorId: enemy.id,
          requestedAction: action,
          appliedAction: "WAIT",
          valid: false,
          invalidReason: "OUT_OF_BOUNDS",
        },
      });
      return { state: nextState, events };
    }

    if (isWall(nextState, targetX, targetY)) {
      events.push({
        type: "ACTION_RESOLVED",
        data: {
          actorType: "enemy",
          actorId: enemy.id,
          requestedAction: action,
          appliedAction: "WAIT",
          valid: false,
          invalidReason: "BLOCKED_BY_WALL",
        },
      });
      return { state: nextState, events };
    }

    if (isOccupiedByAliveEntity(nextState, targetX, targetY, { ignoreEnemyId: enemy.id })) {
      events.push({
        type: "ACTION_RESOLVED",
        data: {
          actorType: "enemy",
          actorId: enemy.id,
          requestedAction: action,
          appliedAction: "WAIT",
          valid: false,
          invalidReason: "BLOCKED_BY_ENTITY",
        },
      });
      return { state: nextState, events };
    }

    const fromX = enemy.x;
    const fromY = enemy.y;
    enemy.x = targetX;
    enemy.y = targetY;

    events.push({
      type: "ACTION_RESOLVED",
      data: {
        actorType: "enemy",
        actorId: enemy.id,
        requestedAction: action,
        appliedAction: action,
        valid: true,
      },
    });

    events.push({
      type: "MOVED",
      actorType: "enemy",
      actorId: enemy.id,
      from: { x: fromX, y: fromY },
      to: { x: targetX, y: targetY },
    });

    return { state: nextState, events };
  }

  const attackDirection = parseAttackDirection(action);
  if (attackDirection) {
    const delta = DIRECTION_DELTAS[attackDirection];
    const targetX = enemy.x + delta.dx;
    const targetY = enemy.y + delta.dy;

    if (!isInBounds(nextState, targetX, targetY)) {
      events.push({
        type: "ACTION_RESOLVED",
        data: {
          actorType: "enemy",
          actorId: enemy.id,
          requestedAction: action,
          appliedAction: "WAIT",
          valid: false,
          invalidReason: "OUT_OF_BOUNDS",
        },
      });
      return { state: nextState, events };
    }

    const targetPlayer = nextState.players.find(
      (player) => player.hp > 0 && player.x === targetX && player.y === targetY,
    );

    if (!targetPlayer) {
      events.push({
        type: "ACTION_RESOLVED",
        data: {
          actorType: "enemy",
          actorId: enemy.id,
          requestedAction: action,
          appliedAction: "WAIT",
          valid: false,
          invalidReason: "NO_TARGET",
        },
      });
      return { state: nextState, events };
    }

    const damage = Math.min(enemy.attackDamage, targetPlayer.hp);
    targetPlayer.hp -= damage;
    nextState.metrics.damageTaken += damage;

    events.push({
      type: "ACTION_RESOLVED",
      data: {
        actorType: "enemy",
        actorId: enemy.id,
        requestedAction: action,
        appliedAction: action,
        valid: true,
      },
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

    return { state: nextState, events };
  }

  events.push({
    type: "ACTION_RESOLVED",
    data: {
      actorType: "enemy",
      actorId: enemy.id,
      requestedAction: action,
      appliedAction: "WAIT",
      valid: false,
      invalidReason: "NO_TARGET",
    },
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
  const events: TransitionResult["events"] = [];

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
