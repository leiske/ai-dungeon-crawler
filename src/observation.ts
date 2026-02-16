import type { GameState, Observation } from "./types.ts";
import { hasLineOfSight, manhattanDistance } from "./spatial.ts";

function toPositionKey(x: number, y: number): string {
  return `${x},${y}`;
}

export function getObservation(state: GameState, playerId: number): Observation {
  const player = state.players.find((candidate) => candidate.id === playerId);

  if (!player) {
    throw new Error(`Cannot build observation: player ${playerId} not found.`);
  }

  const radius = state.rules.visionRadius;
  const visibleTiles: Observation["visibleTiles"] = [];
  const visiblePositionKeys = new Set<string>();

  for (let y = player.y - radius; y <= player.y + radius; y += 1) {
    if (y < 0 || y >= state.map.height) {
      continue;
    }

    const row = state.map.tiles[y];
    if (!row) {
      continue;
    }

    for (let x = player.x - radius; x <= player.x + radius; x += 1) {
      if (x < 0 || x >= state.map.width) {
        continue;
      }

      if (manhattanDistance(player.x, player.y, x, y) > radius) {
        continue;
      }

      const tile = row[x];
      if (!tile) {
        continue;
      }

      if (!hasLineOfSight(state, player.x, player.y, x, y)) {
        continue;
      }

      visibleTiles.push({
        x,
        y,
        tile,
      });
      visiblePositionKeys.add(toPositionKey(x, y));
    }
  }

  const visibleEntities: Observation["visibleEntities"] = [];

  for (const otherPlayer of state.players) {
    if (otherPlayer.id === player.id || otherPlayer.hp <= 0) {
      continue;
    }

    if (!visiblePositionKeys.has(toPositionKey(otherPlayer.x, otherPlayer.y))) {
      continue;
    }

    visibleEntities.push({
      id: otherPlayer.id,
      kind: otherPlayer.kind,
      x: otherPlayer.x,
      y: otherPlayer.y,
      hp: otherPlayer.hp,
      maxHp: otherPlayer.maxHp,
    });
  }

  for (const enemy of state.enemies) {
    if (enemy.hp <= 0) {
      continue;
    }

    if (!visiblePositionKeys.has(toPositionKey(enemy.x, enemy.y))) {
      continue;
    }

    visibleEntities.push({
      id: enemy.id,
      kind: enemy.kind,
      x: enemy.x,
      y: enemy.y,
      hp: enemy.hp,
      maxHp: enemy.maxHp,
    });
  }

  return {
    turn: state.turn,
    self: {
      id: player.id,
      x: player.x,
      y: player.y,
      hp: player.hp,
      maxHp: player.maxHp,
      potionCount: player.potionCount,
    },
    visibleTiles,
    visibleEntities,
    visitedPositions: player.visitedPositions.map((position) => ({
      x: position.x,
      y: position.y,
    })),
  };
}
