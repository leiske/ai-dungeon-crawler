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
