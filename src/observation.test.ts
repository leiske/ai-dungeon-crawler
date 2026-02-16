import { expect, test } from "bun:test";
import { getObservation } from "./observation.ts";
import type { GameState } from "./types.ts";

test("getObservation hides tiles and entities behind walls", () => {
  const state: GameState = {
    seed: 1,
    turn: 1,
    map: {
      width: 5,
      height: 5,
      tiles: [
        ["WALL", "WALL", "WALL", "WALL", "WALL"],
        ["WALL", "FLOOR", "FLOOR", "FLOOR", "WALL"],
        ["WALL", "FLOOR", "WALL", "FLOOR", "WALL"],
        ["WALL", "FLOOR", "FLOOR", "EXIT", "WALL"],
        ["WALL", "WALL", "WALL", "WALL", "WALL"],
      ],
    },
    players: [
      {
        kind: "player",
        id: 1,
        x: 1,
        y: 2,
        hp: 10,
        maxHp: 10,
        potionCount: 1,
        visitedPositions: [],
      },
    ],
    enemies: [
      {
        kind: "enemy",
        id: 101,
        x: 3,
        y: 2,
        hp: 5,
        maxHp: 5,
        attackDamage: 2,
      },
    ],
    rules: {
      maxTurns: 50,
      visionRadius: 4,
      playerAttackDamage: 3,
      potionHealAmount: 5,
    },
    metrics: {
      win: false,
      turnsSurvived: 0,
      damageTaken: 0,
      damageDealt: 0,
      potionsUsed: 0,
      enemiesKilled: 0,
    },
    outcome: "ONGOING",
  };

  const observation = getObservation(state, 1);
  const visibleTilePositions = new Set(
    observation.visibleTiles.map((tile) => `${tile.x},${tile.y}`),
  );

  expect(visibleTilePositions.has("2,2")).toBe(true);
  expect(visibleTilePositions.has("3,2")).toBe(false);
  expect(observation.visibleEntities).toEqual([]);
});
