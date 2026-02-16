import { createAttackAction, createMoveAction, WAIT_ACTION } from "../action-utils.ts";
import {
  DIRECTION_DELTAS,
  getAdjacentDirection,
  hasLineOfSight,
  isInBounds,
  isOccupiedByAliveEntity,
  isWalkable,
  manhattanDistance,
} from "../spatial.ts";
import { DIRECTION_PRIORITY } from "../types.ts";
import type { Direction, EnemyAction, EnemyController, GameState, Player } from "../types.ts";

interface FrontierCell {
  x: number;
  y: number;
  firstDirection: Direction;
}

const ENEMY_AGGRO_RADIUS = 6;

function toPositionKey(x: number, y: number): string {
  return `${x},${y}`;
}

function choosePathDirection(
  state: GameState,
  enemy: Pick<GameState["enemies"][number], "id" | "x" | "y">,
  target: Pick<Player, "x" | "y">,
): Direction | null {
  const queue: FrontierCell[] = [];
  const visited = new Set<string>([toPositionKey(enemy.x, enemy.y)]);

  for (const direction of DIRECTION_PRIORITY) {
    const delta = DIRECTION_DELTAS[direction];
    const nextX = enemy.x + delta.dx;
    const nextY = enemy.y + delta.dy;

    if (!isInBounds(state, nextX, nextY) || !isWalkable(state, nextX, nextY)) {
      continue;
    }

    const isTargetTile = nextX === target.x && nextY === target.y;
    if (
      !isTargetTile &&
      isOccupiedByAliveEntity(state, nextX, nextY, {
        ignoreEnemyId: enemy.id,
      })
    ) {
      continue;
    }

    const key = toPositionKey(nextX, nextY);
    if (visited.has(key)) {
      continue;
    }

    visited.add(key);
    queue.push({
      x: nextX,
      y: nextY,
      firstDirection: direction,
    });
  }

  for (let index = 0; index < queue.length; index += 1) {
    const current = queue[index];
    if (!current) {
      continue;
    }

    if (current.x === target.x && current.y === target.y) {
      return current.firstDirection;
    }

    for (const direction of DIRECTION_PRIORITY) {
      const delta = DIRECTION_DELTAS[direction];
      const nextX = current.x + delta.dx;
      const nextY = current.y + delta.dy;

      if (!isInBounds(state, nextX, nextY) || !isWalkable(state, nextX, nextY)) {
        continue;
      }

      const isTargetTile = nextX === target.x && nextY === target.y;
      if (
        !isTargetTile &&
        isOccupiedByAliveEntity(state, nextX, nextY, {
          ignoreEnemyId: enemy.id,
        })
      ) {
        continue;
      }

      const key = toPositionKey(nextX, nextY);
      if (visited.has(key)) {
        continue;
      }

      visited.add(key);
      queue.push({
        x: nextX,
        y: nextY,
        firstDirection: current.firstDirection,
      });
    }
  }

  return null;
}

function sortPlayersByPriority(players: Player[], enemyX: number, enemyY: number): Player[] {
  return [...players].sort((a, b) => {
    const distanceA = manhattanDistance(enemyX, enemyY, a.x, a.y);
    const distanceB = manhattanDistance(enemyX, enemyY, b.x, b.y);
    if (distanceA !== distanceB) {
      return distanceA - distanceB;
    }
    return a.id - b.id;
  });
}

function canEnemyDetectPlayer(
  state: GameState,
  enemy: Pick<GameState["enemies"][number], "x" | "y">,
  player: Pick<Player, "x" | "y">,
): boolean {
  if (manhattanDistance(enemy.x, enemy.y, player.x, player.y) > ENEMY_AGGRO_RADIUS) {
    return false;
  }

  return hasLineOfSight(state, enemy.x, enemy.y, player.x, player.y);
}

export class GreedyEnemyController implements EnemyController {
  public chooseAction(state: GameState, enemyId: number): EnemyAction {
    const enemy = state.enemies.find((candidate) => candidate.id === enemyId);
    if (!enemy || enemy.hp <= 0) {
      return WAIT_ACTION;
    }

    const alivePlayers = state.players.filter((player) => player.hp > 0);
    if (alivePlayers.length === 0) {
      return WAIT_ACTION;
    }

    const adjacentPlayers = sortPlayersByPriority(
      alivePlayers.filter((player) => manhattanDistance(enemy.x, enemy.y, player.x, player.y) === 1),
      enemy.x,
      enemy.y,
    );

    const adjacentTarget = adjacentPlayers[0];
    if (adjacentTarget) {
      const adjacentDirection = getAdjacentDirection(enemy.x, enemy.y, adjacentTarget.x, adjacentTarget.y);
      if (!adjacentDirection) {
        throw new Error(
          `Adjacent target (${adjacentTarget.x}, ${adjacentTarget.y}) is not cardinally adjacent to enemy ${enemy.id}.`,
        );
      }

      return createAttackAction(adjacentDirection);
    }

    const visibleTargets = sortPlayersByPriority(
      alivePlayers.filter((player) => canEnemyDetectPlayer(state, enemy, player)),
      enemy.x,
      enemy.y,
    );

    const target = visibleTargets[0];
    if (!target) {
      return WAIT_ACTION;
    }

    const direction = choosePathDirection(state, enemy, target);
    if (direction) {
      return createMoveAction(direction);
    }

    return WAIT_ACTION;
  }
}
