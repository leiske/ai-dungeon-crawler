import { WAIT_ACTION } from "../action-utils.ts";
import type { Observation, PlayerAction, PlayerPolicy } from "../types.ts";

export class WaitPolicy implements PlayerPolicy {
  public async chooseAction(_observation: Observation): Promise<PlayerAction> {
    return WAIT_ACTION;
  }
}
