import { generateDungeon } from "./dungeon-generator.ts";
import type { Enemy, ScenarioDefinition } from "./types.ts";

function createInitialEnemies(enemyStarts: Array<{ x: number; y: number }>): Enemy[] {
  return enemyStarts.map((enemyStart, index) => ({
    kind: "enemy",
    id: 101 + index,
    x: enemyStart.x,
    y: enemyStart.y,
    hp: 5,
    maxHp: 5,
    attackDamage: 2,
  }));
}

export function createScenario(seed: number): ScenarioDefinition {
  const dungeon = generateDungeon(seed);

  return {
    id: "dungeon-generated-v0",
    description: "Seeded procedural dungeon with room-and-corridor generation.",
    map: {
      width: dungeon.width,
      height: dungeon.height,
      tiles: dungeon.tiles,
    },
    players: [
      {
        kind: "player",
        id: 1,
        x: dungeon.playerStart.x,
        y: dungeon.playerStart.y,
        hp: 10,
        maxHp: 10,
        potionCount: 1,
        visitedPositions: [],
      },
    ],
    enemies: createInitialEnemies(dungeon.enemyStarts),
    rules: {
      maxTurns: 50,
      visionRadius: 6,
      playerAttackDamage: 3,
      potionHealAmount: 5,
    },
  };
}
