import type { Enemy, ScenarioDefinition, Tile } from "./types.ts";

const MAP_WIDTH = 15;
const MAP_HEIGHT = 15;

function createBorderWallMap(width: number, height: number): Tile[][] {
  const tiles: Tile[][] = [];

  for (let y = 0; y < height; y += 1) {
    const row: Tile[] = [];
    for (let x = 0; x < width; x += 1) {
      const isBorder = x === 0 || y === 0 || x === width - 1 || y === height - 1;
      row.push(isBorder ? "WALL" : "FLOOR");
    }
    tiles.push(row);
  }

  return tiles;
}

function buildFixedTiles(): Tile[][] {
  const tiles = createBorderWallMap(MAP_WIDTH, MAP_HEIGHT);

  const setTile = (x: number, y: number, tile: Tile): void => {
    const row = tiles[y];
    if (!row || row[x] === undefined) {
      throw new Error(`Invalid fixed map coordinate (${x}, ${y})`);
    }
    row[x] = tile;
  };

  const internalWalls: Array<[number, number]> = [
    [5, 1],
    [5, 2],
    [5, 3],
    [5, 4],
    [5, 5],
    [9, 5],
    [10, 5],
    [11, 5],
    [11, 6],
    [11, 7],
    [3, 9],
    [4, 9],
    [5, 9],
    [6, 9],
  ];

  for (const [x, y] of internalWalls) {
    setTile(x, y, "WALL");
  }

  setTile(13, 13, "EXIT");

  return tiles;
}

export function createFixedScenario(seed: number): ScenarioDefinition {
  const enemies: Enemy[] = [
    {
      kind: "enemy",
      id: 101,
      x: 4,
      y: 8,
      hp: 5,
      maxHp: 5,
      attackDamage: 2,
    },
  ];

  return {
    id: "smoke-fixed-v0",
    description: "Fixed deterministic smoke scenario for phase loop validation.",
    map: {
      width: MAP_WIDTH,
      height: MAP_HEIGHT,
      tiles: buildFixedTiles(),
    },
    players: [
      {
        kind: "player",
        id: 1,
        x: 1,
        y: 1,
        hp: 10,
        maxHp: 10,
        potionCount: 1,
        visitedPositions: [],
      },
    ],
    enemies,
    rules: {
      maxTurns: 50,
      visionRadius: 5,
      playerAttackDamage: 3,
      potionHealAmount: 5,
    },
  };
}

export function createScenario(seed: number): ScenarioDefinition {
  return createFixedScenario(seed);
}
