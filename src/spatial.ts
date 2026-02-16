import type { Direction, GameState, Tile } from "./types.ts";

export const DIRECTION_DELTAS: Record<Direction, { dx: number; dy: number }> = {
  N: { dx: 0, dy: -1 },
  S: { dx: 0, dy: 1 },
  E: { dx: 1, dy: 0 },
  W: { dx: -1, dy: 0 },
};

export function manhattanDistance(ax: number, ay: number, bx: number, by: number): number {
  return Math.abs(ax - bx) + Math.abs(ay - by);
}

export function getAdjacentDirection(
  fromX: number,
  fromY: number,
  toX: number,
  toY: number,
): Direction | null {
  const dx = toX - fromX;
  const dy = toY - fromY;

  if (dx === 0 && dy === -1) {
    return "N";
  }
  if (dx === 0 && dy === 1) {
    return "S";
  }
  if (dx === 1 && dy === 0) {
    return "E";
  }
  if (dx === -1 && dy === 0) {
    return "W";
  }

  return null;
}

export function isInBounds(state: GameState, x: number, y: number): boolean {
  return x >= 0 && y >= 0 && x < state.map.width && y < state.map.height;
}

export function getTile(state: GameState, x: number, y: number): Tile | null {
  const row = state.map.tiles[y];
  const tile = row?.[x];
  return tile ?? null;
}

export function isWall(state: GameState, x: number, y: number): boolean {
  return getTile(state, x, y) === "WALL";
}

export function isOpaqueTile(tile: Tile | null): boolean {
  return tile === "WALL";
}

export function hasLineOfSight(
  state: GameState,
  fromX: number,
  fromY: number,
  toX: number,
  toY: number,
): boolean {
  if (!isInBounds(state, fromX, fromY) || !isInBounds(state, toX, toY)) {
    return false;
  }

  let currentX = fromX;
  let currentY = fromY;
  const deltaX = Math.abs(toX - fromX);
  const deltaY = Math.abs(toY - fromY);
  const stepX = fromX < toX ? 1 : -1;
  const stepY = fromY < toY ? 1 : -1;
  let error = deltaX - deltaY;

  while (currentX !== toX || currentY !== toY) {
    const previousX = currentX;
    const previousY = currentY;
    const doubledError = error * 2;
    let movedX = false;
    let movedY = false;

    if (doubledError > -deltaY) {
      error -= deltaY;
      currentX += stepX;
      movedX = true;
    }

    if (doubledError < deltaX) {
      error += deltaX;
      currentY += stepY;
      movedY = true;
    }

    if (movedX && movedY) {
      const horizontalStepTile = getTile(state, previousX + stepX, previousY);
      const verticalStepTile = getTile(state, previousX, previousY + stepY);
      if (isOpaqueTile(horizontalStepTile) && isOpaqueTile(verticalStepTile)) {
        return false;
      }
    }

    if (currentX === toX && currentY === toY) {
      return true;
    }

    if (isOpaqueTile(getTile(state, currentX, currentY))) {
      return false;
    }
  }

  return true;
}

export function isWalkable(state: GameState, x: number, y: number): boolean {
  const tile = getTile(state, x, y);
  return tile !== null && tile !== "WALL";
}

export interface OccupancyOptions {
  ignoreEnemyId?: number;
  ignorePlayerId?: number;
}

export function isOccupiedByAliveEntity(
  state: GameState,
  x: number,
  y: number,
  options: OccupancyOptions = {},
): boolean {
  const playerOccupied = state.players.some(
    (player) =>
      player.hp > 0 &&
      player.id !== options.ignorePlayerId &&
      player.x === x &&
      player.y === y,
  );

  if (playerOccupied) {
    return true;
  }

  return state.enemies.some(
    (enemy) =>
      enemy.hp > 0 && enemy.id !== options.ignoreEnemyId && enemy.x === x && enemy.y === y,
  );
}
