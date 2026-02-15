import type { PlayerAction } from "./types.ts";

export type LlmEvent =
  | {
      type: "LLM_REQUEST_STARTED";
      turn: number;
      playerId: number;
    }
  | {
      type: "LLM_THINKING_STARTED";
      turn: number;
      playerId: number;
    }
  | {
      type: "LLM_THINKING_DELTA";
      turn: number;
      playerId: number;
      delta: string;
    }
  | {
      type: "LLM_THINKING_ENDED";
      turn: number;
      playerId: number;
    }
  | {
      type: "LLM_OUTPUT_STARTED";
      turn: number;
      playerId: number;
    }
  | {
      type: "LLM_OUTPUT_DELTA";
      turn: number;
      playerId: number;
      delta: string;
    }
  | {
      type: "LLM_OUTPUT_ENDED";
      turn: number;
      playerId: number;
    }
  | {
      type: "LLM_REQUEST_COMPLETED";
      turn: number;
      playerId: number;
      action: PlayerAction;
      latencyMs: number;
      stopReason?: string;
      whyThisAction?: string;
      confidence?: number;
      tokenUsage: {
        input: number;
        output: number;
        total: number;
      };
      issue?: string;
    }
  | {
      type: "LLM_REQUEST_FAILED";
      turn: number;
      playerId: number;
      message: string;
    };

export type LlmEventHandler = (event: LlmEvent) => void | Promise<void>;
