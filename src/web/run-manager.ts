import { GreedyEnemyController } from "../enemy/greedy.ts";
import type { EpisodeEvent } from "../episode-events.ts";
import { LlmCodexPolicy } from "../policy/llm.ts";
import { DEFAULT_PERSONA_ID, getPersonaById } from "../policy/persona.ts";
import { runEpisode } from "../run.ts";
import { createScenario } from "../scenario.ts";
import { cloneState, createInitialState } from "../sim.ts";
import type { EpisodeResult, GameState, Metrics, ScenarioDefinition } from "../types.ts";

export type RunChannel = "system" | "episode" | "llm";
export type RunStatus = "running" | "finished" | "failed";

export interface RunEventEnvelope {
  runId: string;
  seq: number;
  at: string;
  channel: RunChannel;
  eventType: string;
  state: GameState;
  data: unknown;
}

export interface StartRunInput {
  seed: number;
  maxTurns: number;
  personaId?: string;
}

export type StartRunResult =
  | {
      ok: true;
      runId: string;
    }
  | {
      ok: false;
      code: "RUN_ALREADY_ACTIVE" | "INVALID_PERSONA";
      message: string;
      activeRunId?: string;
    };

export interface RunSessionSnapshot {
  runId: string;
  status: RunStatus;
  createdAt: string;
  finishedAt?: string;
  scenarioId: string;
  seed: number;
  maxTurns: number;
  personaId: string;
  eventCount: number;
  latestState: GameState;
  result?: {
    outcome: EpisodeResult["outcome"];
    metrics: Metrics;
  };
  errorMessage?: string;
}

export interface RunStreamSubscription {
  backlog: RunEventEnvelope[];
  detach: () => void;
}

interface RunSession {
  runId: string;
  status: RunStatus;
  createdAt: string;
  finishedAt?: string;
  scenarioId: string;
  seed: number;
  maxTurns: number;
  personaId: string;
  nextSeq: number;
  latestState: GameState;
  history: RunEventEnvelope[];
  subscribers: Set<RunEventSubscriber>;
  result?: {
    outcome: EpisodeResult["outcome"];
    metrics: Metrics;
  };
  errorMessage?: string;
}

type RunEventSubscriber = (event: RunEventEnvelope) => void;

interface RunFinishedData {
  outcome: EpisodeResult["outcome"];
  metrics: Metrics;
}

function describeError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

function nowIso(): string {
  return new Date().toISOString();
}

function applyMaxTurnsToScenario(scenario: ScenarioDefinition, maxTurns: number): ScenarioDefinition {
  return {
    ...scenario,
    rules: {
      ...scenario.rules,
      maxTurns,
    },
  };
}

function buildRunId(counter: number): string {
  const timestamp = new Date().toISOString().replace(/[-:.TZ]/g, "");
  return `run-${timestamp}-${counter}`;
}

function cloneEnvelope(envelope: RunEventEnvelope): RunEventEnvelope {
  return {
    ...envelope,
    state: cloneState(envelope.state),
  };
}

function withoutEpisodeState(event: EpisodeEvent): Record<string, unknown> {
  if ("state" in event) {
    const { state: _state, ...rest } = event;
    return rest;
  }

  return event;
}

function getEpisodeState(event: EpisodeEvent): GameState | null {
  if ("state" in event) {
    return event.state;
  }

  return null;
}

export class RunManager {
  private readonly sessions = new Map<string, RunSession>();
  private activeRunId: string | null = null;
  private runCounter = 0;

  public startRun(input: StartRunInput): StartRunResult {
    if (this.activeRunId) {
      return {
        ok: false,
        code: "RUN_ALREADY_ACTIVE",
        message: `Run '${this.activeRunId}' is still active.`,
        activeRunId: this.activeRunId,
      };
    }

    const personaId = input.personaId ?? DEFAULT_PERSONA_ID;
    try {
      getPersonaById(personaId);
    } catch (error) {
      return {
        ok: false,
        code: "INVALID_PERSONA",
        message: describeError(error),
      };
    }

    const baseScenario = createScenario(input.seed);
    const scenario = applyMaxTurnsToScenario(baseScenario, input.maxTurns);

    this.runCounter += 1;
    const runId = buildRunId(this.runCounter);

    const session: RunSession = {
      runId,
      status: "running",
      createdAt: nowIso(),
      scenarioId: scenario.id,
      seed: input.seed,
      maxTurns: input.maxTurns,
      personaId,
      nextSeq: 1,
      latestState: createInitialState(scenario, input.seed),
      history: [],
      subscribers: new Set(),
    };

    this.sessions.set(runId, session);
    this.activeRunId = runId;

    this.publish(session, {
      channel: "system",
      eventType: "RUN_STARTED",
      data: {
        runId,
        scenarioId: scenario.id,
        seed: input.seed,
        maxTurns: input.maxTurns,
        personaId,
      },
    });

    void this.executeRun(session);

    return {
      ok: true,
      runId,
    };
  }

  public hasSession(runId: string): boolean {
    return this.sessions.has(runId);
  }

  public getActiveRunId(): string | null {
    return this.activeRunId;
  }

  public getSessionSnapshot(runId: string): RunSessionSnapshot | null {
    const session = this.sessions.get(runId);
    if (!session) {
      return null;
    }

    return {
      runId: session.runId,
      status: session.status,
      createdAt: session.createdAt,
      finishedAt: session.finishedAt,
      scenarioId: session.scenarioId,
      seed: session.seed,
      maxTurns: session.maxTurns,
      personaId: session.personaId,
      eventCount: session.history.length,
      latestState: cloneState(session.latestState),
      result: session.result,
      errorMessage: session.errorMessage,
    };
  }

  public attachSubscriber(runId: string, subscriber: RunEventSubscriber): RunStreamSubscription | null {
    const session = this.sessions.get(runId);
    if (!session) {
      return null;
    }

    const backlog = session.history.map((item) => cloneEnvelope(item));
    session.subscribers.add(subscriber);

    return {
      backlog,
      detach: () => {
        session.subscribers.delete(subscriber);
      },
    };
  }

  private async executeRun(session: RunSession): Promise<void> {
    try {
      const scenario = applyMaxTurnsToScenario(createScenario(session.seed), session.maxTurns);
      const playerPolicy = new LlmCodexPolicy({
        reasoning: "low",
        personaId: session.personaId,
        onEvent: async (event) => {
          this.publish(session, {
            channel: "llm",
            eventType: event.type,
            data: event,
          });
        },
      });

      const result = await runEpisode({
        scenario,
        seed: session.seed,
        playerPolicy,
        enemyController: new GreedyEnemyController(),
        traceEnabled: true,
        onEvent: async (event) => {
          this.handleEpisodeEvent(session, event);
        },
      });

      this.finishRun(session, {
        outcome: result.outcome,
        metrics: result.metrics,
      });
    } catch (error) {
      this.failRun(session, describeError(error));
    }
  }

  private handleEpisodeEvent(session: RunSession, event: EpisodeEvent): void {
    const eventState = getEpisodeState(event);
    if (eventState) {
      session.latestState = cloneState(eventState);
    }

    this.publish(session, {
      channel: "episode",
      eventType: event.type,
      data: withoutEpisodeState(event),
    });
  }

  private finishRun(session: RunSession, data: RunFinishedData): void {
    session.status = "finished";
    session.finishedAt = nowIso();
    session.result = {
      outcome: data.outcome,
      metrics: data.metrics,
    };

    this.publish(session, {
      channel: "system",
      eventType: "RUN_FINISHED",
      data,
    });

    if (this.activeRunId === session.runId) {
      this.activeRunId = null;
    }
  }

  private failRun(session: RunSession, errorMessage: string): void {
    session.status = "failed";
    session.finishedAt = nowIso();
    session.errorMessage = errorMessage;

    this.publish(session, {
      channel: "system",
      eventType: "RUN_FAILED",
      data: {
        message: errorMessage,
      },
    });

    if (this.activeRunId === session.runId) {
      this.activeRunId = null;
    }
  }

  private publish(
    session: RunSession,
    input: {
      channel: RunChannel;
      eventType: string;
      data: unknown;
    },
  ): void {
    const envelope: RunEventEnvelope = {
      runId: session.runId,
      seq: session.nextSeq,
      at: nowIso(),
      channel: input.channel,
      eventType: input.eventType,
      state: cloneState(session.latestState),
      data: input.data,
    };

    session.nextSeq += 1;
    session.history.push(envelope);

    for (const subscriber of session.subscribers) {
      try {
        subscriber(envelope);
      } catch {
        session.subscribers.delete(subscriber);
      }
    }
  }
}
