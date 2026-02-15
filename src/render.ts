import type { GameState } from "./types.ts";

function tileToChar(tile: GameState["map"]["tiles"][number][number]): string {
  switch (tile) {
    case "WALL":
      return "#";
    case "FLOOR":
      return ".";
    case "EXIT":
      return "E";
    default:
      return "?";
  }
}

export function render(state: GameState): string {
  const lines: string[] = [];

  for (let y = 0; y < state.map.height; y += 1) {
    const row = state.map.tiles[y];
    if (!row) {
      continue;
    }

    const chars: string[] = [];

    for (let x = 0; x < state.map.width; x += 1) {
      const tile = row[x];
      chars.push(tile ? tileToChar(tile) : "?");
    }

    lines.push(chars.join(""));
  }

  const board = lines.map((line) => line.split(""));

  for (const enemy of state.enemies) {
    if (enemy.hp <= 0) {
      continue;
    }

    const row = board[enemy.y];
    if (!row || row[enemy.x] === undefined) {
      continue;
    }

    row[enemy.x] = "M";
  }

  for (const player of state.players) {
    if (player.hp <= 0) {
      continue;
    }

    const row = board[player.y];
    if (!row || row[player.x] === undefined) {
      continue;
    }

    row[player.x] = "P";
  }

  return board.map((row) => row.join("")).join("\n");
}
