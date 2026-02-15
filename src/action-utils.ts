import type { Action, AttackAction, Direction, MoveAction } from "./types.ts";

function parseDirectionWithPrefix(action: Action, prefix: "MOVE_" | "ATTACK_"): Direction | null {
  if (!action.startsWith(prefix)) {
    return null;
  }

  const direction = action.slice(prefix.length);
  if (direction === "N" || direction === "S" || direction === "E" || direction === "W") {
    return direction;
  }

  return null;
}

export function parseMoveDirection(action: MoveAction | Action): Direction | null {
  return parseDirectionWithPrefix(action, "MOVE_");
}

export function parseAttackDirection(action: AttackAction | Action): Direction | null {
  return parseDirectionWithPrefix(action, "ATTACK_");
}
