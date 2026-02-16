import { createSeededRng } from "./rng.ts";
import type { Position, Tile } from "./types.ts";

interface Room {
  x: number;
  y: number;
  width: number;
  height: number;
  center: Position;
}

interface DistanceCell extends Position {
  distance: number;
}

export interface GeneratedDungeon {
  width: number;
  height: number;
  tiles: Tile[][];
  playerStart: Position;
  enemyStart: Position;
  exit: Position;
}

const DUNGEON_WIDTH = 41;
const DUNGEON_HEIGHT = 31;

const MIN_ROOM_COUNT = 8;
const MAX_ROOM_COUNT = 14;
const ROOM_PLACEMENT_ATTEMPTS = 260;

const MIN_ROOM_WIDTH = 4;
const MAX_ROOM_WIDTH = 8;
const MIN_ROOM_HEIGHT = 4;
const MAX_ROOM_HEIGHT = 8;

const ROOM_PADDING = 1;

const CARDINAL_STEPS: readonly Position[] = [
  { x: 0, y: -1 },
  { x: 0, y: 1 },
  { x: 1, y: 0 },
  { x: -1, y: 0 },
];

function toPositionKey(x: number, y: number): string {
  return `${x},${y}`;
}

function createFilledTiles(width: number, height: number, tile: Tile): Tile[][] {
  const tiles: Tile[][] = [];

  for (let y = 0; y < height; y += 1) {
    const row: Tile[] = [];
    for (let x = 0; x < width; x += 1) {
      row.push(tile);
    }
    tiles.push(row);
  }

  return tiles;
}

function setTile(tiles: Tile[][], x: number, y: number, tile: Tile): void {
  const row = tiles[y];
  if (!row || row[x] === undefined) {
    throw new Error(`Invalid dungeon coordinate (${x}, ${y}).`);
  }

  row[x] = tile;
}

function carveRoom(tiles: Tile[][], room: Room): void {
  for (let y = room.y; y < room.y + room.height; y += 1) {
    for (let x = room.x; x < room.x + room.width; x += 1) {
      setTile(tiles, x, y, "FLOOR");
    }
  }
}

function carveHorizontalCorridor(tiles: Tile[][], startX: number, endX: number, y: number): void {
  const from = Math.min(startX, endX);
  const to = Math.max(startX, endX);

  for (let x = from; x <= to; x += 1) {
    setTile(tiles, x, y, "FLOOR");
  }
}

function carveVerticalCorridor(tiles: Tile[][], startY: number, endY: number, x: number): void {
  const from = Math.min(startY, endY);
  const to = Math.max(startY, endY);

  for (let y = from; y <= to; y += 1) {
    setTile(tiles, x, y, "FLOOR");
  }
}

function carveCorridorBetweenRooms(
  tiles: Tile[][],
  from: Position,
  to: Position,
  horizontalFirst: boolean,
): void {
  if (horizontalFirst) {
    carveHorizontalCorridor(tiles, from.x, to.x, from.y);
    carveVerticalCorridor(tiles, from.y, to.y, to.x);
    return;
  }

  carveVerticalCorridor(tiles, from.y, to.y, from.x);
  carveHorizontalCorridor(tiles, from.x, to.x, to.y);
}

function roomsOverlapWithPadding(left: Room, right: Room): boolean {
  const leftMinX = left.x - ROOM_PADDING;
  const leftMinY = left.y - ROOM_PADDING;
  const leftMaxX = left.x + left.width - 1 + ROOM_PADDING;
  const leftMaxY = left.y + left.height - 1 + ROOM_PADDING;

  const rightMinX = right.x;
  const rightMinY = right.y;
  const rightMaxX = right.x + right.width - 1;
  const rightMaxY = right.y + right.height - 1;

  const overlapX = leftMinX <= rightMaxX && leftMaxX >= rightMinX;
  const overlapY = leftMinY <= rightMaxY && leftMaxY >= rightMinY;
  return overlapX && overlapY;
}

function createRandomRoom(
  rng: ReturnType<typeof createSeededRng>,
  mapWidth: number,
  mapHeight: number,
): Room {
  const width = rng.nextInt(MIN_ROOM_WIDTH, MAX_ROOM_WIDTH);
  const height = rng.nextInt(MIN_ROOM_HEIGHT, MAX_ROOM_HEIGHT);

  const maxX = mapWidth - width - 2;
  const maxY = mapHeight - height - 2;

  if (maxX < 1 || maxY < 1) {
    throw new Error("Dungeon dimensions are too small for configured room sizes.");
  }

  const x = rng.nextInt(1, maxX);
  const y = rng.nextInt(1, maxY);

  return {
    x,
    y,
    width,
    height,
    center: {
      x: x + Math.floor(width / 2),
      y: y + Math.floor(height / 2),
    },
  };
}

function buildRooms(
  rng: ReturnType<typeof createSeededRng>,
  tiles: Tile[][],
  width: number,
  height: number,
): Room[] {
  const rooms: Room[] = [];

  for (let attempt = 0; attempt < ROOM_PLACEMENT_ATTEMPTS; attempt += 1) {
    if (rooms.length >= MAX_ROOM_COUNT) {
      break;
    }

    const room = createRandomRoom(rng, width, height);
    const overlaps = rooms.some((placedRoom) => roomsOverlapWithPadding(placedRoom, room));
    if (overlaps) {
      continue;
    }

    carveRoom(tiles, room);

    const previousRoom = rooms[rooms.length - 1];
    if (previousRoom) {
      const horizontalFirst = rng.nextFloat() < 0.5;
      carveCorridorBetweenRooms(tiles, previousRoom.center, room.center, horizontalFirst);
    }

    rooms.push(room);
  }

  if (rooms.length < MIN_ROOM_COUNT) {
    throw new Error(
      `Failed to generate dungeon with at least ${MIN_ROOM_COUNT} rooms. Generated ${rooms.length}.`,
    );
  }

  return rooms;
}

function isWalkableTile(tile: Tile | undefined): boolean {
  return tile === "FLOOR";
}

function computeFloorDistances(tiles: Tile[][], start: Position): DistanceCell[] {
  const startTile = tiles[start.y]?.[start.x];
  if (!isWalkableTile(startTile)) {
    throw new Error(`Distance origin (${start.x}, ${start.y}) is not on a floor tile.`);
  }

  const distances: DistanceCell[] = [];
  const queue: DistanceCell[] = [{ x: start.x, y: start.y, distance: 0 }];
  const seen = new Set<string>([toPositionKey(start.x, start.y)]);

  for (let index = 0; index < queue.length; index += 1) {
    const current = queue[index];
    if (!current) {
      continue;
    }

    distances.push(current);

    for (const step of CARDINAL_STEPS) {
      const nextX = current.x + step.x;
      const nextY = current.y + step.y;
      if (!isWalkableTile(tiles[nextY]?.[nextX])) {
        continue;
      }

      const key = toPositionKey(nextX, nextY);
      if (seen.has(key)) {
        continue;
      }

      seen.add(key);
      queue.push({
        x: nextX,
        y: nextY,
        distance: current.distance + 1,
      });
    }
  }

  return distances;
}

function compareDistanceCells(left: DistanceCell, right: DistanceCell): number {
  if (right.distance !== left.distance) {
    return right.distance - left.distance;
  }
  if (left.y !== right.y) {
    return left.y - right.y;
  }
  return left.x - right.x;
}

function chooseExitAndEnemyStart(distances: DistanceCell[], playerStart: Position): {
  exit: Position;
  enemyStart: Position;
} {
  const candidates = distances
    .filter((cell) => !(cell.x === playerStart.x && cell.y === playerStart.y))
    .sort(compareDistanceCells);

  if (candidates.length < 2) {
    throw new Error("Dungeon generation produced too few walkable tiles for exit and enemy placement.");
  }

  const exitCandidate = candidates[0];
  const enemyCandidate = candidates[1];

  if (!exitCandidate || !enemyCandidate) {
    throw new Error("Dungeon placement selection failed.");
  }

  return {
    exit: { x: exitCandidate.x, y: exitCandidate.y },
    enemyStart: { x: enemyCandidate.x, y: enemyCandidate.y },
  };
}

export function generateDungeon(seed: number): GeneratedDungeon {
  const rng = createSeededRng(seed);
  const tiles = createFilledTiles(DUNGEON_WIDTH, DUNGEON_HEIGHT, "WALL");
  const rooms = buildRooms(rng, tiles, DUNGEON_WIDTH, DUNGEON_HEIGHT);

  const firstRoom = rooms[0];
  if (!firstRoom) {
    throw new Error("Dungeon generation produced no rooms.");
  }

  const playerStart: Position = {
    x: firstRoom.center.x,
    y: firstRoom.center.y,
  };

  const distances = computeFloorDistances(tiles, playerStart);
  const { exit, enemyStart } = chooseExitAndEnemyStart(distances, playerStart);
  setTile(tiles, exit.x, exit.y, "EXIT");

  return {
    width: DUNGEON_WIDTH,
    height: DUNGEON_HEIGHT,
    tiles,
    playerStart,
    enemyStart,
    exit,
  };
}
