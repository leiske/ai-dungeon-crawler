import type {
  Action,
  AttackAction,
  Direction,
  ItemId,
  MoveAction,
  UseItemAction,
  WaitAction,
} from "./types.ts";

export const WAIT_ACTION: WaitAction = { kind: "WAIT" };

export function createMoveAction(direction: Direction): MoveAction {
  return {
    kind: "MOVE",
    direction,
  };
}

export function createAttackAction(direction: Direction): AttackAction {
  return {
    kind: "ATTACK",
    direction,
  };
}

export function createUseItemAction(itemId: ItemId): UseItemAction {
  return {
    kind: "USE_ITEM",
    itemId,
  };
}

export function isMoveAction(action: Action): action is MoveAction {
  return action.kind === "MOVE";
}

export function isAttackAction(action: Action): action is AttackAction {
  return action.kind === "ATTACK";
}

export function isUseItemAction(action: Action): action is UseItemAction {
  return action.kind === "USE_ITEM";
}
