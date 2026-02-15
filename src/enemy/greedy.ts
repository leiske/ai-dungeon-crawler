import {
  ATTACK_ACTION_BY_DIRECTION,
  DIRECTION_PRIORITY,
  MOVE_ACTION_BY_DIRECTION,
} from "../types.ts";
import {
  DIRECTION_DELTAS,
  getAdjacentDirection,
  isInBounds,
  isOccupiedByAliveEntity,
  isWalkable,
  manhattanDistance,
} from "../spatial.ts";
import type { EnemyController, GameState, Player } from "../types.ts";

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
  public chooseAction(state: GameState, enemyId: number) {
    const enemy = state.enemies.find((candidate) => candidate.id === enemyId);
    if (!enemy || enemy.hp <= 0) {
      return "WAIT";
    }

    const alivePlayers = state.players.filter((player) => player.hp > 0);
    if (alivePlayers.length === 0) {
      return "WAIT";
    }

    const [target] = sortPlayersByPriority(alivePlayers, enemy.x, enemy.y);
    if (!target) {
      return "WAIT";
    }

    const adjacentDirection = getAdjacentDirection(enemy.x, enemy.y, target.x, target.y);
    if (adjacentDirection) {
      return ATTACK_ACTION_BY_DIRECTION[adjacentDirection];
    }

    const currentDistance = manhattanDistance(enemy.x, enemy.y, target.x, target.y);
    for (const direction of DIRECTION_PRIORITY) {
      const delta = DIRECTION_DELTAS[direction];
      const nextX = enemy.x + delta.dx;
      const nextY = enemy.y + delta.dy;

      if (!isInBounds(state, nextX, nextY)) {
        continue;
      }

      if (!isWalkable(state, nextX, nextY)) {
        continue;
      }

      if (isOccupiedByAliveEntity(state, nextX, nextY, { ignoreEnemyId: enemy.id })) {
        continue;
      }

      const nextDistance = manhattanDistance(nextX, nextY, target.x, target.y);
      if (nextDistance < currentDistance) {
        return MOVE_ACTION_BY_DIRECTION[direction];
      }
    }

    return "WAIT";
  }
}
