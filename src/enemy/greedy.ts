import { createAttackAction, createMoveAction, WAIT_ACTION } from "../action-utils.ts";
import {
  DIRECTION_DELTAS,
  getAdjacentDirection,
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

    const [target] = sortPlayersByPriority(alivePlayers, enemy.x, enemy.y);
    if (!target) {
      return WAIT_ACTION;
    }

    const adjacentDirection = getAdjacentDirection(enemy.x, enemy.y, target.x, target.y);
    if (adjacentDirection) {
      return createAttackAction(adjacentDirection);
    }

    const direction = choosePathDirection(state, enemy, target);
    if (direction) {
      return createMoveAction(direction);
    }

    return WAIT_ACTION;
  }
}
