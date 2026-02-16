import { Elysia } from "elysia";
import { z } from "zod";
import { listPersonas } from "../policy/persona.ts";
import { RunManager } from "./run-manager.ts";
import type { RunEventEnvelope } from "./run-manager.ts";

const DEFAULT_SEED = 42;
const DEFAULT_MAX_TURNS = 5;
const KEEP_ALIVE_INTERVAL_MS = 15_000;

const WEB_DIR = `${import.meta.dir}/../../web`;
const PHASER_MODULE_PATH = `${import.meta.dir}/../../node_modules/phaser/dist/phaser.esm.js`;

const runStartBodySchema = z
  .object({
    seed: z.number().int().nonnegative().optional(),
    maxTurns: z.number().int().positive().optional(),
    personaId: z.string().trim().min(1).optional(),
  })
  .strict();

interface ParsedRunStartBody {
  seed: number;
  maxTurns: number;
  personaId?: string;
}

function parsePort(value: string | undefined): number {
  if (!value) {
    return 3100;
  }

  if (!/^\d+$/.test(value)) {
    throw new Error(`Invalid PORT '${value}'. Expected a positive integer.`);
  }

  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`Invalid PORT '${value}'. Expected a positive integer.`);
  }

  return parsed;
}

function parseRunStartBody(body: unknown):
  | {
      ok: true;
      value: ParsedRunStartBody;
    }
  | {
      ok: false;
      message: string;
    } {
  const parsed = runStartBodySchema.safeParse(body ?? {});
  if (!parsed.success) {
    return {
      ok: false,
      message: parsed.error.issues[0]?.message ?? "Invalid run payload.",
    };
  }

  return {
    ok: true,
    value: {
      seed: parsed.data.seed ?? DEFAULT_SEED,
      maxTurns: parsed.data.maxTurns ?? DEFAULT_MAX_TURNS,
      personaId: parsed.data.personaId,
    },
  };
}

function toSseChunk(envelope: RunEventEnvelope): string {
  return `id:${envelope.seq}\ndata:${JSON.stringify(envelope)}\n\n`;
}

function createRunStreamResponse(params: {
  runManager: RunManager;
  runId: string;
  signal: AbortSignal;
}): Response {
  const encoder = new TextEncoder();

  let detach: (() => void) | null = null;
  let keepAliveTimer: ReturnType<typeof setInterval> | null = null;
  let closed = false;

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const close = (): void => {
        if (closed) {
          return;
        }

        closed = true;

        if (keepAliveTimer) {
          clearInterval(keepAliveTimer);
          keepAliveTimer = null;
        }

        if (detach) {
          detach();
          detach = null;
        }

        controller.close();
      };

      const subscription = params.runManager.attachSubscriber(params.runId, (envelope) => {
        if (closed) {
          return;
        }
        controller.enqueue(encoder.encode(toSseChunk(envelope)));
      });

      if (!subscription) {
        controller.error(new Error(`Run '${params.runId}' not found.`));
        return;
      }

      detach = subscription.detach;

      for (const envelope of subscription.backlog) {
        controller.enqueue(encoder.encode(toSseChunk(envelope)));
      }

      keepAliveTimer = setInterval(() => {
        if (closed) {
          return;
        }

        controller.enqueue(encoder.encode(":keep-alive\n\n"));
      }, KEEP_ALIVE_INTERVAL_MS);

      params.signal.addEventListener("abort", close, { once: true });
    },
    cancel() {
      if (keepAliveTimer) {
        clearInterval(keepAliveTimer);
        keepAliveTimer = null;
      }

      if (detach) {
        detach();
        detach = null;
      }

      closed = true;
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}

const runManager = new RunManager();

const app = new Elysia()
  .get("/", () => Bun.file(`${WEB_DIR}/index.html`))
  .get("/app.js", () => Bun.file(`${WEB_DIR}/app.js`))
  .get("/phaser-board.js", () => Bun.file(`${WEB_DIR}/phaser-board.js`))
  .get("/vendor/phaser.js", () => Bun.file(PHASER_MODULE_PATH))
  .get("/styles.css", () => Bun.file(`${WEB_DIR}/styles.css`))
  .get("/api/health", () => ({ ok: true }))
  .get("/api/personas", () => ({
    personas: listPersonas().map((persona) => ({
      id: persona.id,
      description: persona.description,
    })),
  }))
  .get("/api/runs/active", ({ status }) => {
    const activeRunId = runManager.getActiveRunId();
    if (!activeRunId) {
      return status(404, {
        message: "No active run.",
      });
    }

    const run = runManager.getSessionSnapshot(activeRunId);
    if (!run) {
      return status(404, {
        message: `Run '${activeRunId}' not found.`,
      });
    }

    return {
      run,
    };
  })
  .get("/api/runs/:runId", ({ params, status }) => {
    const run = runManager.getSessionSnapshot(params.runId);
    if (!run) {
      return status(404, {
        message: `Run '${params.runId}' not found.`,
      });
    }

    return {
      run,
    };
  })
  .get("/api/runs/:runId/events", ({ params, request, status }) => {
    if (!runManager.hasSession(params.runId)) {
      return status(404, {
        message: `Run '${params.runId}' not found.`,
      });
    }

    return createRunStreamResponse({
      runManager,
      runId: params.runId,
      signal: request.signal,
    });
  })
  .post("/api/runs", ({ body, status }) => {
    const parsedBody = parseRunStartBody(body);
    if (!parsedBody.ok) {
      return status(400, {
        message: parsedBody.message,
      });
    }

    const result = runManager.startRun(parsedBody.value);
    if (!result.ok) {
      if (result.code === "RUN_ALREADY_ACTIVE") {
        return status(409, result);
      }

      return status(400, result);
    }

    const run = runManager.getSessionSnapshot(result.runId);
    if (!run) {
      return status(500, {
        message: `Run '${result.runId}' could not be loaded after start.`,
      });
    }

    return status(201, {
      run,
    });
  });

export type App = typeof app;

const port = parsePort(Bun.env.PORT);
app.listen(port);

if (!app.server) {
  throw new Error("Elysia server did not initialize.");
}

console.log(`Web server listening on http://${app.server.hostname}:${app.server.port}`);
