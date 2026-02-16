const MAX_LOG_LINES = 240;
const MAX_THINKING_LINE_LENGTH = 260;

const elementIds = {
  form: "run-form",
  startButton: "start-run",
  personaId: "persona-id",
  seed: "seed",
  maxTurns: "max-turns",
  statusText: "status-text",
  board: "board",
  episodeLog: "episode-log",
  llmLog: "llm-log",
};

const ui = {
  form: document.getElementById(elementIds.form),
  startButton: document.getElementById(elementIds.startButton),
  personaId: document.getElementById(elementIds.personaId),
  seed: document.getElementById(elementIds.seed),
  maxTurns: document.getElementById(elementIds.maxTurns),
  statusText: document.getElementById(elementIds.statusText),
  board: document.getElementById(elementIds.board),
  episodeLog: document.getElementById(elementIds.episodeLog),
  llmLog: document.getElementById(elementIds.llmLog),
};

if (
  !ui.form ||
  !ui.startButton ||
  !ui.personaId ||
  !ui.seed ||
  !ui.maxTurns ||
  !ui.statusText ||
  !ui.board ||
  !ui.episodeLog ||
  !ui.llmLog
) {
  throw new Error("UI boot failed. Required DOM nodes are missing.");
}

let eventSource = null;
let activeRunId = null;

const llmThinkingBuffers = new Map();

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asString(value, fallback = "") {
  return typeof value === "string" ? value : fallback;
}

function asNumber(value, fallback = 0) {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function clampText(text, maxLength) {
  if (text.length <= maxLength) {
    return text;
  }
  return `${text.slice(0, maxLength - 3)}...`;
}

function setStatus(text, isError = false) {
  ui.statusText.textContent = text;
  ui.statusText.classList.toggle("error", isError);
}

function appendLog(target, line) {
  const currentLines = target.textContent ? target.textContent.split("\n") : [];
  currentLines.push(line);

  while (currentLines.length > MAX_LOG_LINES) {
    currentLines.shift();
  }

  target.textContent = currentLines.join("\n");
  target.scrollTop = target.scrollHeight;
}

function clearLogs() {
  ui.episodeLog.textContent = "";
  ui.llmLog.textContent = "";
}

function closeStream() {
  if (!eventSource) {
    return;
  }

  eventSource.close();
  eventSource = null;
}

function formatActor(actorType, actorId) {
  return actorType === "player" ? `P#${actorId}` : `M#${actorId}`;
}

function formatAction(action) {
  if (!isRecord(action)) {
    return "UNKNOWN_ACTION";
  }

  const kind = asString(action.kind, "UNKNOWN_ACTION");
  switch (kind) {
    case "MOVE":
    case "ATTACK":
      return `${kind}(${asString(action.direction, "?")})`;
    case "USE_ITEM":
      return `USE_ITEM(${asString(action.itemId, "?")})`;
    case "WAIT":
      return "WAIT";
    default:
      return kind;
  }
}

function formatMetrics(metrics) {
  if (!isRecord(metrics)) {
    return "metrics unavailable";
  }

  return [
    `win=${String(metrics.win === true)}`,
    `turnsSurvived=${asNumber(metrics.turnsSurvived, 0)}`,
    `damageTaken=${asNumber(metrics.damageTaken, 0)}`,
    `damageDealt=${asNumber(metrics.damageDealt, 0)}`,
    `potionsUsed=${asNumber(metrics.potionsUsed, 0)}`,
    `enemiesKilled=${asNumber(metrics.enemiesKilled, 0)}`,
  ].join(", ");
}

function formatCombatEvent(turn, event) {
  if (!isRecord(event)) {
    return null;
  }

  const type = asString(event.type);
  switch (type) {
    case "ACTION_RESOLVED": {
      const data = isRecord(event.data) ? event.data : {};
      if (data.valid === true) {
        return null;
      }

      const requestedAction = formatAction(data.requestedAction);
      const invalidReason = asString(data.invalidReason, "UNKNOWN");
      return `T${turn} ${formatActor(data.actorType, asNumber(data.actorId, 0))} fails ${requestedAction} (${invalidReason})`;
    }
    case "ATTACK":
      return `T${turn} ${formatActor(event.attackerType, asNumber(event.attackerId, 0))} hits ${formatActor(event.targetType, asNumber(event.targetId, 0))} for ${asNumber(event.damage, 0)} (hp=${asNumber(event.targetHpAfter, 0)})`;
    case "HEALED":
      return `T${turn} ${formatActor(event.actorType, asNumber(event.actorId, 0))} heals ${asNumber(event.amount, 0)} (hp=${asNumber(event.hpAfter, 0)})`;
    case "DEATH":
      return `T${turn} ${formatActor(event.actorType, asNumber(event.actorId, 0))} dies`;
    default:
      return null;
  }
}

function collectCombatLines(turn, events) {
  const lines = [];
  if (!Array.isArray(events)) {
    return lines;
  }

  for (const event of events) {
    const detail = formatCombatEvent(turn, event);
    if (detail) {
      lines.push(detail);
    }
  }

  return lines;
}

function formatEpisodeLines(eventType, data) {
  const payload = isRecord(data) ? data : {};
  const turn = asNumber(payload.turn, 0);

  switch (eventType) {
    case "EPISODE_STARTED":
      return [
        `Encounter starts | scenario=${asString(payload.scenarioId, "unknown")} seed=${asNumber(payload.seed, 0)}`,
      ];
    case "PLAYER_ACTION_APPLIED":
      return collectCombatLines(turn, payload.events);
    case "ENEMY_ACTION_APPLIED":
      return collectCombatLines(turn, payload.events);
    case "EPISODE_FINISHED":
      return [
        `Encounter ends | outcome=${asString(payload.outcome, "UNKNOWN")} | ${formatMetrics(payload.metrics)}`,
      ];
    default:
      return [];
  }
}

function tileToChar(tile) {
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

function renderBoardFromState(state) {
  if (!state || !state.map) {
    ui.board.textContent = "Waiting for state...";
    return;
  }

  const lines = [];
  for (let y = 0; y < state.map.height; y += 1) {
    const row = state.map.tiles[y];
    if (!row) {
      continue;
    }

    const chars = [];
    for (let x = 0; x < state.map.width; x += 1) {
      chars.push(tileToChar(row[x]));
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

  ui.board.textContent = board.map((row) => row.join("")).join("\n");
}

function thinkingKey(turn, playerId) {
  return `${turn}:${playerId}`;
}

function startThinkingBuffer(turn, playerId) {
  const key = thinkingKey(turn, playerId);
  if (!llmThinkingBuffers.has(key)) {
    llmThinkingBuffers.set(key, {
      turn,
      playerId,
      text: "",
    });
  }
}

function appendThinkingBuffer(turn, playerId, delta) {
  const key = thinkingKey(turn, playerId);
  startThinkingBuffer(turn, playerId);

  const entry = llmThinkingBuffers.get(key);
  if (!entry || typeof delta !== "string" || delta.length === 0) {
    return;
  }

  entry.text += delta;
  if (entry.text.length > 16_000) {
    entry.text = entry.text.slice(-16_000);
  }
}

function normalizeThinkingText(text) {
  return text.replace(/[\r\n\t]+/g, " ").replace(/\s+/g, " ").trim();
}

function flushThinkingBuffer(turn, playerId) {
  const key = thinkingKey(turn, playerId);
  const entry = llmThinkingBuffers.get(key);
  if (!entry) {
    return false;
  }

  llmThinkingBuffers.delete(key);
  const cleaned = normalizeThinkingText(entry.text);
  if (!cleaned) {
    return false;
  }

  appendLog(
    ui.llmLog,
    `Turn ${turn} | P#${playerId} thinking: ${clampText(cleaned, MAX_THINKING_LINE_LENGTH)}`,
  );
  return true;
}

function handleSystemEnvelope(envelope) {
  if (envelope.eventType === "RUN_STARTED") {
    ui.startButton.disabled = true;
    setStatus(`Run ${envelope.runId} started.`);
    return;
  }

  if (envelope.eventType === "RUN_FINISHED") {
    ui.startButton.disabled = false;
    const payload = isRecord(envelope.data) ? envelope.data : {};
    setStatus(`Run ${envelope.runId} finished (${asString(payload.outcome, "UNKNOWN")}).`);
    closeStream();
    return;
  }

  if (envelope.eventType === "RUN_FAILED") {
    ui.startButton.disabled = false;
    const payload = isRecord(envelope.data) ? envelope.data : {};
    setStatus(asString(payload.message, "Run failed."), true);
    closeStream();
  }
}

function handleEpisodeEnvelope(envelope) {
  const lines = formatEpisodeLines(envelope.eventType, envelope.data);
  for (const line of lines) {
    appendLog(ui.episodeLog, line);
  }
}

function handleLlmEnvelope(envelope) {
  const payload = isRecord(envelope.data) ? envelope.data : {};
  const turn = asNumber(payload.turn, -1);
  const playerId = asNumber(payload.playerId, -1);

  switch (envelope.eventType) {
    case "LLM_REQUEST_STARTED":
      appendLog(ui.llmLog, `Turn ${turn} | P#${playerId} LLM request started`);
      return;
    case "LLM_THINKING_STARTED":
      startThinkingBuffer(turn, playerId);
      appendLog(ui.llmLog, `Turn ${turn} | P#${playerId} thinking...`);
      return;
    case "LLM_THINKING_DELTA":
      appendThinkingBuffer(turn, playerId, asString(payload.delta));
      return;
    case "LLM_THINKING_ENDED":
      if (!flushThinkingBuffer(turn, playerId)) {
        appendLog(ui.llmLog, `Turn ${turn} | P#${playerId} thinking complete`);
      }
      return;
    case "LLM_OUTPUT_STARTED":
      appendLog(ui.llmLog, `Turn ${turn} | P#${playerId} generating action...`);
      return;
    case "LLM_OUTPUT_DELTA":
      return;
    case "LLM_OUTPUT_ENDED":
      appendLog(ui.llmLog, `Turn ${turn} | P#${playerId} action output complete`);
      return;
    case "LLM_MEMORY_UPDATED": {
      const applied = isRecord(payload.applied) ? payload.applied : {};
      const workingUpdates = asNumber(applied.workingUpdates, 0);
      const journalAppends = asNumber(applied.journalAppends, 0);
      const journalCompactions = asNumber(applied.journalCompactions, 0);

      appendLog(
        ui.llmLog,
        `Turn ${turn} | P#${playerId} memory updates: working=${workingUpdates}, journal=${journalAppends}, compactions=${journalCompactions}`,
      );
      return;
    }
    case "LLM_REQUEST_COMPLETED": {
      flushThinkingBuffer(turn, playerId);

      const tokenUsage = isRecord(payload.tokenUsage) ? payload.tokenUsage : {};
      const totalTokens = asNumber(tokenUsage.total, 0);
      const latencyMs = asNumber(payload.latencyMs, 0);

      let line =
        `Turn ${turn} | P#${playerId} chose ${formatAction(payload.action)} ` +
        `(${latencyMs}ms, ${totalTokens}t)`;

      const why = asString(payload.whyThisAction).trim();
      if (why.length > 0) {
        line += ` | why: ${clampText(why, 140)}`;
      }

      const issue = asString(payload.issue).trim();
      if (issue.length > 0) {
        line += ` | issue: ${clampText(issue, 120)}`;
      }

      appendLog(ui.llmLog, line);
      return;
    }
    case "LLM_REQUEST_FAILED": {
      flushThinkingBuffer(turn, playerId);
      const message = asString(payload.message, "unknown error");
      appendLog(ui.llmLog, `Turn ${turn} | P#${playerId} request failed: ${message}`);
      return;
    }
    default:
      appendLog(ui.llmLog, `LLM event ${envelope.eventType}`);
  }
}

function onEnvelope(envelope) {
  if (!isRecord(envelope)) {
    return;
  }

  if (envelope.state) {
    renderBoardFromState(envelope.state);
  }

  if (envelope.channel === "system") {
    handleSystemEnvelope(envelope);
    return;
  }

  if (envelope.channel === "episode") {
    handleEpisodeEnvelope(envelope);
    return;
  }

  if (envelope.channel === "llm") {
    handleLlmEnvelope(envelope);
  }
}

function connectToRun(runId) {
  closeStream();
  eventSource = new EventSource(`/api/runs/${runId}/events`);

  eventSource.onopen = () => {
    setStatus(`Streaming run ${runId}`);
  };

  eventSource.onmessage = (event) => {
    if (!event.data) {
      return;
    }

    try {
      const envelope = JSON.parse(event.data);
      onEnvelope(envelope);
    } catch {
      setStatus("Received malformed stream payload.", true);
    }
  };

  eventSource.onerror = () => {
    setStatus("Stream connection interrupted. Trying to reconnect...", true);
  };
}

async function loadPersonas() {
  const response = await fetch("/api/personas");
  if (!response.ok) {
    throw new Error(`Failed to load personas (${response.status})`);
  }

  const payload = await response.json();
  if (!payload || !Array.isArray(payload.personas)) {
    throw new Error("Persona payload is invalid.");
  }

  ui.personaId.innerHTML = "";

  for (const persona of payload.personas) {
    const option = document.createElement("option");
    option.value = persona.id;
    option.textContent = `${persona.id} - ${persona.description}`;
    ui.personaId.append(option);
  }
}

async function startRunRequest(payload) {
  const response = await fetch("/api/runs", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  const json = await response.json();
  if (!response.ok) {
    const message =
      json && typeof json.message === "string" ? json.message : `Request failed (${response.status})`;
    const error = new Error(message);
    error.statusCode = response.status;
    error.payload = json;
    throw error;
  }

  if (!json || typeof json !== "object" || !json.run || typeof json.run.runId !== "string") {
    throw new Error("Server did not return a valid run payload.");
  }

  return json.run.runId;
}

async function attachActiveRunIfPresent() {
  const response = await fetch("/api/runs/active");
  if (response.status === 404) {
    return;
  }

  if (!response.ok) {
    setStatus(`Could not check active run (${response.status}).`, true);
    return;
  }

  const payload = await response.json();
  if (!payload || !payload.run || typeof payload.run.runId !== "string") {
    return;
  }

  activeRunId = payload.run.runId;
  renderBoardFromState(payload.run.latestState);
  setStatus(`Attached to active run ${activeRunId}`);
  ui.startButton.disabled = true;
  connectToRun(activeRunId);
}

ui.form.addEventListener("submit", async (event) => {
  event.preventDefault();

  const seed = Number(ui.seed.value);
  const maxTurns = Number(ui.maxTurns.value);
  const personaId = ui.personaId.value;

  ui.startButton.disabled = true;
  setStatus("Starting run...");

  try {
    const runId = await startRunRequest({
      seed,
      maxTurns,
      personaId,
    });

    activeRunId = runId;
    clearLogs();
    connectToRun(runId);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const isConflict =
      error && typeof error === "object" && "statusCode" in error && Number(error.statusCode) === 409;
    let attachedToActiveRun = false;
    setStatus(message, !isConflict);

    if (isConflict) {
      const payload = error.payload;
      if (payload && typeof payload === "object" && typeof payload.activeRunId === "string") {
        activeRunId = payload.activeRunId;
        attachedToActiveRun = true;
        connectToRun(activeRunId);
      }
    }

    ui.startButton.disabled = attachedToActiveRun;
  }
});

async function boot() {
  setStatus("Loading personas...");

  try {
    await loadPersonas();
    setStatus("Ready");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    setStatus(message, true);
    return;
  }

  await attachActiveRunIfPresent();
}

void boot();
