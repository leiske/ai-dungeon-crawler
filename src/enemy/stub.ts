import type { EnemyAction, EnemyController, GameState } from "../types.ts";

export class WaitEnemyController implements EnemyController {
  public chooseAction(_state: GameState, _enemyId: number): EnemyAction {
    return "WAIT";
  }
}
