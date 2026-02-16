import { expect, test } from "bun:test";
import { compactObservationForPrompt } from "./llm.ts";
import type { Observation } from "../types.ts";

test("compactObservationForPrompt compacts keys and limits visited positions to last 10", () => {
  const visitedPositions = Array.from({ length: 12 }, (_, index) => ({
    x: index,
    y: index + 100,
  }));

  const observation: Observation = {
    turn: 7,
    self: {
      id: 1,
      x: 4,
      y: 5,
      hp: 8,
      maxHp: 10,
      potionCount: 1,
    },
    visibleTiles: [
      { x: 4, y: 5, tile: "FLOOR" },
      { x: 5, y: 5, tile: "WALL" },
      { x: 6, y: 5, tile: "EXIT" },
    ],
    visibleEntities: [{ id: 101, kind: "enemy", x: 6, y: 5, hp: 5, maxHp: 5 }],
    visitedPositions,
  };

  const compact = compactObservationForPrompt(observation, { w: [], j: [] });

  expect(compact).toEqual({
    t: 7,
    s: [4, 5, 8, 10, 1],
    vt: [
      [4, 5, "F"],
      [5, 5, "W"],
      [6, 5, "E"],
    ],
    ve: [[101, "m", 6, 5, 5, 5]],
    vp: [
      [2, 102],
      [3, 103],
      [4, 104],
      [5, 105],
      [6, 106],
      [7, 107],
      [8, 108],
      [9, 109],
      [10, 110],
      [11, 111],
    ],
    vm: {
      w: [],
      j: [],
    },
  });
});
