import type { EpisodeEvent } from "./episode-events.ts";
import type { LlmEvent, LlmJournalMemoryEntry, LlmWorkingMemoryEntry } from "./llm-events.ts";
import { render } from "./render.ts";
import type { Action, GameState, SimulationEvent } from "./types.ts";

const CLEAR_SCREEN = "\u001b[2J";
const CURSOR_HOME = "\u001b[H";
const SPINNER_INTERVAL_MS = 180;
const DELTA_RENDER_INTERVAL_MS = 220;
const MAX_COMBAT_LOG_LINES = 14;
const MAX_LLM_CURRENT_THINKING_LINES = 4;
const MAX_LLM_HISTORY_ROWS = 8;
const MAX_LLM_ANNOTATION_LENGTH = 74;
const MAX_MEMORY_WORKING_LINES = 6;
const MAX_MEMORY_JOURNAL_LINES = 6;
const MAX_MEMORY_COMMIT_ROWS = 8;
const MAX_MEMORY_COMMIT_ANNOTATION_LENGTH = 78;
const MIN_THINKING_SEGMENT_LENGTH = 36;
const MAX_THINKING_SEGMENT_LENGTH = 92;

interface BottomLayout {
  leftWidth: number;
  rightWidth: number;
  gapWidth: number;
}

interface LlmPaneModel {
  statusLine: string;
  stage: string;
  currentThinkingLines: readonly string[];
  recentRows: readonly string[];
}

interface MemoryPaneModel {
  working: readonly LlmWorkingMemoryEntry[];
  journal: readonly LlmJournalMemoryEntry[];
  recentCommitRows: readonly string[];
}

interface FrameModel {
  state: GameState;
  statusLine: string;
  combatLog: readonly string[];
  llm: LlmPaneModel;
  memory: MemoryPaneModel;
}

function isInteractiveTerminal(): boolean {
  return process.stdout.isTTY === true;
}

function formatActor(actorType: "player" | "enemy", actorId: number): string {
  return actorType === "player" ? `P#${actorId}` : `M#${actorId}`;
}

function formatAction(action: Action): string {
  switch (action.kind) {
    case "MOVE":
    case "ATTACK":
      return `${action.kind}(${action.direction})`;
    case "USE_ITEM":
      return `${action.kind}(${action.itemId})`;
    case "WAIT":
      return "WAIT";
  }
}

function formatSimulationEvent(event: SimulationEvent): string | null {
  switch (event.type) {
    case "ACTION_RESOLVED": {
      if (event.data.valid) {
        return null;
      }

      return `${formatActor(event.data.actorType, event.data.actorId)} invalid ${formatAction(event.data.requestedAction)} -> WAIT (${event.data.invalidReason})`;
    }
    case "MOVED":
      return `${formatActor(event.actorType, event.actorId)} moved (${event.from.x},${event.from.y}) -> (${event.to.x},${event.to.y})`;
    case "ATTACK":
      return `${formatActor(event.attackerType, event.attackerId)} hit ${formatActor(event.targetType, event.targetId)} for ${event.damage} (hp=${event.targetHpAfter})`;
    case "HEALED":
      return `${formatActor(event.actorType, event.actorId)} healed ${event.amount} (hp=${event.hpAfter})`;
    case "DEATH":
      return `${formatActor(event.actorType, event.actorId)} died`;
    case "TURN_FINALIZED":
      return `Turn ${event.turn} finalized`;
    case "OUTCOME_SET":
      return `Outcome ${event.outcome}`;
  }
}

function nextSpinnerIndex(current: number): number {
  return (current + 1) % 4;
}

function spinnerFrame(index: number): string {
  switch (index) {
    case 0:
      return "-";
    case 1:
      return "\\";
    case 2:
      return "|";
    default:
      return "/";
  }
}

function truncateLine(line: string, width: number): string {
  if (width <= 0) {
    return "";
  }

  if (line.length <= width) {
    return line;
  }

  if (width <= 3) {
    return line.slice(0, width);
  }

  return `${line.slice(0, width - 3)}...`;
}

function padRight(line: string, width: number): string {
  const clipped = truncateLine(line, width);
  if (clipped.length >= width) {
    return clipped;
  }
  return `${clipped}${" ".repeat(width - clipped.length)}`;
}

function wrapLine(line: string, width: number): string[] {
  if (width <= 0) {
    return [""];
  }

  const normalized = line.replace(/\t/g, "  ");
  if (normalized.length <= width) {
    return [normalized];
  }

  const chunks: string[] = [];
  let remaining = normalized;

  while (remaining.length > width) {
    const cut = remaining.lastIndexOf(" ", width);
    if (cut > 0) {
      chunks.push(remaining.slice(0, cut));
      remaining = remaining.slice(cut + 1);
      continue;
    }

    chunks.push(remaining.slice(0, width));
    remaining = remaining.slice(width);
  }

  if (remaining.length > 0) {
    chunks.push(remaining);
  }

  return chunks;
}

function parseColumnCount(value: string | undefined): number {
  if (!value) {
    return 0;
  }

  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    return 0;
  }

  return parsed;
}

function getTerminalWidth(): number {
  const processColumns = process.stdout.columns;
  if (Number.isSafeInteger(processColumns) && processColumns > 0) {
    return processColumns;
  }

  return parseColumnCount(Bun.env.COLUMNS);
}

function centerLinesHorizontally(lines: readonly string[], terminalWidth: number): string[] {
  if (terminalWidth <= 0 || lines.length === 0) {
    return [...lines];
  }

  const contentWidth = lines.reduce((max, line) => Math.max(max, line.length), 0);
  const leftPadding = Math.max(0, Math.floor((terminalWidth - contentWidth) / 2));

  if (leftPadding === 0) {
    return [...lines];
  }

  const padding = " ".repeat(leftPadding);
  return lines.map((line) => `${padding}${line}`);
}

function computeBottomLayout(terminalWidth: number): BottomLayout {
  const totalWidth = terminalWidth > 0 ? terminalWidth : 120;
  const gapWidth = 3;
  const contentWidth = Math.max(1, totalWidth - gapWidth);

  let leftWidth = Math.floor(contentWidth / 3);
  let rightWidth = contentWidth - leftWidth;

  const minLeftWidth = 20;
  const minRightWidth = 24;

  if (leftWidth < minLeftWidth) {
    leftWidth = Math.min(minLeftWidth, contentWidth - 1);
    rightWidth = contentWidth - leftWidth;
  }

  if (rightWidth < minRightWidth) {
    rightWidth = Math.min(minRightWidth, contentWidth - 1);
    leftWidth = contentWidth - rightWidth;
  }

  return {
    leftWidth,
    rightWidth,
    gapWidth,
  };
}

function mergeColumns(
  leftLines: readonly string[],
  rightLines: readonly string[],
  layout: BottomLayout,
): string {
  const totalLines = Math.max(leftLines.length, rightLines.length);
  const rows: string[] = [];
  const gap = " ".repeat(layout.gapWidth);

  for (let index = 0; index < totalLines; index += 1) {
    const left = leftLines[index] ?? "";
    const right = rightLines[index] ?? "";
    rows.push(`${padRight(left, layout.leftWidth)}${gap}${truncateLine(right, layout.rightWidth)}`);
  }

  return rows.join("\n");
}

function shortenText(value: string, maxLength: number): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxLength) {
    return normalized;
  }

  if (maxLength <= 3) {
    return normalized.slice(0, maxLength);
  }

  return `${normalized.slice(0, maxLength - 3)}...`;
}

function cleanThinkingLine(value: string): string | null {
  const cleaned = value
    .replace(/[`*_>#]/g, " ")
    .replace(/\s+/g, " ")
    .replace(/^[\-:;.,\s]+/, "")
    .trim();

  if (cleaned.length === 0) {
    return null;
  }

  return cleaned;
}

function buildCombatPaneLines(combatLog: readonly string[], leftWidth: number): string[] {
  const lines: string[] = ["Combat Log"];
  if (combatLog.length === 0) {
    lines.push("- none");
    return lines;
  }

  for (const item of combatLog) {
    const wrapped = wrapLine(`- ${item}`, leftWidth);
    lines.push(...wrapped);
  }

  return lines;
}

function buildLlmPaneLines(model: LlmPaneModel, rightWidth: number): string[] {
  const currentThinking =
    model.currentThinkingLines.length > 0
      ? model.currentThinkingLines.map((line) => `- ${truncateLine(line, Math.max(0, rightWidth - 2))}`)
      : ["- waiting"];

  const recentRows =
    model.recentRows.length > 0
      ? model.recentRows.map((line) => `- ${truncateLine(line, Math.max(0, rightWidth - 2))}`)
      : ["- none"];

  return [
    "LLM Log",
    `Now ${model.statusLine} | ${model.stage}`,
    "Current Thinking",
    ...currentThinking,
    "",
    `Recent Decisions (${MAX_LLM_HISTORY_ROWS})`,
    ...recentRows,
  ];
}

function sortMemoryEntriesByPriority<T extends { turn: number; salience: number }>(
  entries: readonly T[],
): T[] {
  return [...entries].sort((left, right) => {
    if (right.turn !== left.turn) {
      return right.turn - left.turn;
    }
    return right.salience - left.salience;
  });
}

function formatMemoryStateLine(entry: {
  turn: number;
  kind: string;
  salience: number;
  confidence: number;
  text: string;
}): string {
  return `- t${entry.turn} ${entry.kind} s${entry.salience.toFixed(2)} c${entry.confidence.toFixed(2)} ${entry.text}`;
}

function buildWorkingMemoryPaneLines(entries: readonly LlmWorkingMemoryEntry[], width: number): string[] {
  const lines: string[] = ["Working Memory"];
  const visible = sortMemoryEntriesByPriority(entries).slice(0, MAX_MEMORY_WORKING_LINES);

  if (visible.length === 0) {
    lines.push("- none");
    return lines;
  }

  for (const entry of visible) {
    lines.push(...wrapLine(formatMemoryStateLine(entry), width));
  }

  return lines;
}

function buildJournalMemoryPaneLines(entries: readonly LlmJournalMemoryEntry[], width: number): string[] {
  const lines: string[] = ["Long-Term Memory"];
  const visible = sortMemoryEntriesByPriority(entries).slice(0, MAX_MEMORY_JOURNAL_LINES);

  if (visible.length === 0) {
    lines.push("- none");
    return lines;
  }

  for (const entry of visible) {
    lines.push(...wrapLine(formatMemoryStateLine(entry), width));
  }

  return lines;
}

function buildMemoryCommitLines(rows: readonly string[], width: number): string[] {
  const lines: string[] = ["Recent Memory Commits"];

  if (rows.length === 0) {
    lines.push("- none");
    return lines;
  }

  for (const row of rows) {
    lines.push(...wrapLine(`- ${row}`, width));
  }

  return lines;
}

function buildFrame(model: FrameModel): string {
  const terminalWidth = getTerminalWidth();
  const displayWidth = terminalWidth > 0 ? terminalWidth : 120;
  const boardLines = centerLinesHorizontally(render(model.state).split("\n"), displayWidth);

  const topLines = [`Status ${model.statusLine}`, "", "", "", ...boardLines, ""];
  const bottomLayout = computeBottomLayout(displayWidth);
  const bottomLines = mergeColumns(
    buildCombatPaneLines(model.combatLog, bottomLayout.leftWidth),
    buildLlmPaneLines(model.llm, bottomLayout.rightWidth),
    bottomLayout,
  );

  const memoryLayout = computeBottomLayout(displayWidth);
  const memoryColumns = mergeColumns(
    buildWorkingMemoryPaneLines(model.memory.working, memoryLayout.leftWidth),
    buildJournalMemoryPaneLines(model.memory.journal, memoryLayout.rightWidth),
    memoryLayout,
  );

  const memoryCommitLines = buildMemoryCommitLines(model.memory.recentCommitRows, displayWidth);

  return [
    topLines.join("\n"),
    bottomLines,
    "",
    "Memory Log",
    memoryColumns,
    "",
    ...memoryCommitLines,
  ].join("\n");
}

export class TerminalMapRenderer {
  private state: GameState | null = null;
  private statusLine = "starting";
  private spinnerActive = false;
  private spinnerIndex = 0;
  private spinnerTimer: ReturnType<typeof setInterval> | null = null;
  private readonly combatLog: string[] = [];

  private llmStatusLine = "idle";
  private llmStage = "idle";
  private llmThinkingBuffer = "";
  private readonly llmCurrentThinkingLines: string[] = [];
  private readonly llmRecentRows: string[] = [];

  private memoryWorking: LlmWorkingMemoryEntry[] = [];
  private memoryJournal: LlmJournalMemoryEntry[] = [];
  private readonly memoryCommitRows: string[] = [];

  private deltaRenderTimer: ReturnType<typeof setTimeout> | null = null;

  private appendCombatLog(line: string): void {
    this.combatLog.push(line);
    while (this.combatLog.length > MAX_COMBAT_LOG_LINES) {
      this.combatLog.shift();
    }
  }

  private appendSimulationEvents(events: readonly SimulationEvent[]): void {
    for (const event of events) {
      const line = formatSimulationEvent(event);
      if (line) {
        this.appendCombatLog(line);
      }
    }
  }

  private appendThinkingLine(value: string): void {
    const cleaned = cleanThinkingLine(value);
    if (!cleaned) {
      return;
    }

    const lastLine = this.llmCurrentThinkingLines[this.llmCurrentThinkingLines.length - 1];
    if (lastLine === cleaned) {
      return;
    }

    this.llmCurrentThinkingLines.push(cleaned);
    while (this.llmCurrentThinkingLines.length > MAX_LLM_CURRENT_THINKING_LINES) {
      this.llmCurrentThinkingLines.shift();
    }
  }

  private findThinkingSplitIndex(buffer: string): number {
    if (buffer.length < MIN_THINKING_SEGMENT_LENGTH) {
      return -1;
    }

    const sentenceBreakers = [". ", "! ", "? ", "; "];
    for (const breaker of sentenceBreakers) {
      const index = buffer.indexOf(breaker);
      if (index >= MIN_THINKING_SEGMENT_LENGTH - 1) {
        return index + 1;
      }
    }

    if (buffer.length > MAX_THINKING_SEGMENT_LENGTH) {
      const spaceIndex = buffer.lastIndexOf(" ", MAX_THINKING_SEGMENT_LENGTH);
      if (spaceIndex >= MIN_THINKING_SEGMENT_LENGTH) {
        return spaceIndex;
      }
    }

    return -1;
  }

  private drainThinkingBuffer(force: boolean): void {
    this.llmThinkingBuffer = this.llmThinkingBuffer.replace(/\r/g, "\n");

    while (true) {
      const newlineIndex = this.llmThinkingBuffer.indexOf("\n");
      if (newlineIndex >= 0) {
        this.appendThinkingLine(this.llmThinkingBuffer.slice(0, newlineIndex));
        this.llmThinkingBuffer = this.llmThinkingBuffer.slice(newlineIndex + 1);
        continue;
      }

      const splitIndex = this.findThinkingSplitIndex(this.llmThinkingBuffer);
      if (splitIndex >= 0) {
        this.appendThinkingLine(this.llmThinkingBuffer.slice(0, splitIndex));
        this.llmThinkingBuffer = this.llmThinkingBuffer.slice(splitIndex);
        continue;
      }

      break;
    }

    if (force && this.llmThinkingBuffer.trim().length > 0) {
      this.appendThinkingLine(this.llmThinkingBuffer);
      this.llmThinkingBuffer = "";
    }
  }

  private appendThinkingDelta(delta: string): void {
    this.llmThinkingBuffer += delta;
    this.drainThinkingBuffer(false);
  }

  private scheduleDeltaRender(): void {
    if (!isInteractiveTerminal()) {
      return;
    }

    if (this.deltaRenderTimer) {
      return;
    }

    this.deltaRenderTimer = setTimeout(() => {
      this.deltaRenderTimer = null;
      this.renderFrame();
    }, DELTA_RENDER_INTERVAL_MS);
  }

  private appendRecentLlmRow(row: string): void {
    this.llmRecentRows.push(row);
    while (this.llmRecentRows.length > MAX_LLM_HISTORY_ROWS) {
      this.llmRecentRows.shift();
    }
  }

  private appendMemoryCommitRow(row: string): void {
    this.memoryCommitRows.push(row);
    while (this.memoryCommitRows.length > MAX_MEMORY_COMMIT_ROWS) {
      this.memoryCommitRows.shift();
    }
  }

  private formatWorkingCommitRow(entry: LlmWorkingMemoryEntry): string {
    const text = shortenText(entry.text, MAX_MEMORY_COMMIT_ANNOTATION_LENGTH);
    return `t${entry.turn} +W ${entry.kind} s${entry.salience.toFixed(2)} c${entry.confidence.toFixed(2)} ${text}`;
  }

  private formatJournalCommitRow(entry: LlmJournalMemoryEntry): string {
    const text = shortenText(entry.text, MAX_MEMORY_COMMIT_ANNOTATION_LENGTH);
    return `t${entry.turn} +J ${entry.kind} s${entry.salience.toFixed(2)} c${entry.confidence.toFixed(2)} ${text}`;
  }

  private buildCompletedRow(event: Extract<LlmEvent, { type: "LLM_REQUEST_COMPLETED" }>): string {
    const annotationSource =
      event.whyThisAction ??
      this.llmCurrentThinkingLines[this.llmCurrentThinkingLines.length - 1] ??
      event.issue ??
      "decision complete";
    const annotation = shortenText(annotationSource, MAX_LLM_ANNOTATION_LENGTH);

    let row =
      `t${event.turn} P#${event.playerId} ${formatAction(event.action)} ` +
      `${event.latencyMs}ms ${event.tokenUsage.total}t | ${annotation}`;

    if (event.issue) {
      row = `${row} [issue]`;
    }

    return row;
  }

  private buildFailedRow(event: Extract<LlmEvent, { type: "LLM_REQUEST_FAILED" }>): string {
    return `t${event.turn} P#${event.playerId} WAIT error | ${shortenText(event.message, MAX_LLM_ANNOTATION_LENGTH)}`;
  }

  private setStatusLine(statusLine: string): void {
    this.statusLine = statusLine;
  }

  private startSpinner(statusLine: string): void {
    this.stopSpinner();
    this.statusLine = statusLine;

    if (!isInteractiveTerminal()) {
      return;
    }

    this.spinnerActive = true;
    this.spinnerIndex = 0;
    this.spinnerTimer = setInterval(() => {
      this.spinnerIndex = nextSpinnerIndex(this.spinnerIndex);
      this.renderFrame();
    }, SPINNER_INTERVAL_MS);
  }

  private stopSpinner(): void {
    if (this.spinnerTimer) {
      clearInterval(this.spinnerTimer);
      this.spinnerTimer = null;
    }

    this.spinnerActive = false;
    this.spinnerIndex = 0;
  }

  private getDisplayStatusLine(): string {
    if (!this.spinnerActive) {
      return this.statusLine;
    }

    return `${this.statusLine} ${spinnerFrame(this.spinnerIndex)}`;
  }

  private renderFrame(): void {
    if (!this.state) {
      return;
    }

    if (!isInteractiveTerminal()) {
      return;
    }

    const frame = buildFrame({
      state: this.state,
      statusLine: this.getDisplayStatusLine(),
      combatLog: this.combatLog,
      llm: {
        statusLine: this.llmStatusLine,
        stage: this.llmStage,
        currentThinkingLines: this.llmCurrentThinkingLines,
        recentRows: this.llmRecentRows,
      },
      memory: {
        working: this.memoryWorking,
        journal: this.memoryJournal,
        recentCommitRows: this.memoryCommitRows,
      },
    });

    Bun.stdout.write(`${CLEAR_SCREEN}${CURSOR_HOME}${frame}\n`);
  }

  public dispose(): void {
    if (this.deltaRenderTimer) {
      clearTimeout(this.deltaRenderTimer);
      this.deltaRenderTimer = null;
    }

    this.stopSpinner();
  }

  public consume(event: EpisodeEvent): void {
    switch (event.type) {
      case "EPISODE_STARTED":
        this.state = event.state;
        this.setStatusLine(`turn ${event.state.turn} | waiting for player`);
        this.appendCombatLog(`episode started (seed=${event.seed})`);
        this.llmStatusLine = "idle";
        this.llmStage = "idle";
        this.llmThinkingBuffer = "";
        this.llmCurrentThinkingLines.length = 0;
        this.llmRecentRows.length = 0;
        this.memoryWorking = [];
        this.memoryJournal = [];
        this.memoryCommitRows.length = 0;
        this.renderFrame();
        return;
      case "PLAYER_ACTION_REQUESTED":
        this.startSpinner(`turn ${event.turn} | P#${event.playerId} waiting on LLM`);
        this.renderFrame();
        return;
      case "PLAYER_ACTION_CHOSEN":
        this.stopSpinner();
        this.setStatusLine(`turn ${event.turn} | P#${event.playerId} chose ${formatAction(event.action)}`);
        this.appendCombatLog(`P#${event.playerId} chose ${formatAction(event.action)}`);
        this.renderFrame();
        return;
      case "PLAYER_ACTION_APPLIED":
        this.state = event.state;
        this.setStatusLine(`turn ${event.turn} | resolving P#${event.playerId}`);
        this.appendSimulationEvents(event.events);
        this.renderFrame();
        return;
      case "ENEMY_ACTION_CHOSEN":
        this.setStatusLine(`turn ${event.turn} | M#${event.enemyId} chose ${formatAction(event.action)}`);
        this.appendCombatLog(`M#${event.enemyId} chose ${formatAction(event.action)}`);
        this.renderFrame();
        return;
      case "ENEMY_ACTION_APPLIED":
        this.state = event.state;
        this.setStatusLine(`turn ${event.turn} | resolving M#${event.enemyId}`);
        this.appendSimulationEvents(event.events);
        this.renderFrame();
        return;
      case "TURN_FINALIZED":
        this.state = event.state;
        this.setStatusLine(`turn ${event.state.turn} | waiting for player`);
        this.appendSimulationEvents(event.events);
        this.renderFrame();
        return;
      case "EPISODE_FINISHED":
        this.stopSpinner();
        this.state = event.state;
        this.setStatusLine(`episode finished | ${event.outcome}`);
        this.appendCombatLog(`episode finished with ${event.outcome}`);
        this.renderFrame();
        return;
    }
  }

  public consumeLlmEvent(event: LlmEvent): void {
    switch (event.type) {
      case "LLM_REQUEST_STARTED":
        this.llmStatusLine = `P#${event.playerId} turn ${event.turn}`;
        this.llmStage = "requesting";
        this.llmThinkingBuffer = "";
        this.llmCurrentThinkingLines.length = 0;
        this.renderFrame();
        return;
      case "LLM_THINKING_STARTED":
        this.llmStage = "thinking";
        this.renderFrame();
        return;
      case "LLM_THINKING_DELTA":
        this.appendThinkingDelta(event.delta);
        this.scheduleDeltaRender();
        return;
      case "LLM_THINKING_ENDED":
        this.drainThinkingBuffer(true);
        this.llmStage = "generating action";
        this.renderFrame();
        return;
      case "LLM_OUTPUT_STARTED":
        this.llmStage = "generating action";
        this.renderFrame();
        return;
      case "LLM_OUTPUT_DELTA":
        this.scheduleDeltaRender();
        return;
      case "LLM_OUTPUT_ENDED":
        this.llmStage = "parsing";
        this.renderFrame();
        return;
      case "LLM_MEMORY_UPDATED":
        this.memoryWorking = [...event.working];
        this.memoryJournal = [...event.journal];

        for (const entry of event.committedWorking) {
          this.appendMemoryCommitRow(this.formatWorkingCommitRow(entry));
        }

        for (const entry of event.committedJournal) {
          this.appendMemoryCommitRow(this.formatJournalCommitRow(entry));
        }

        if (event.applied.journalCompactions > 0) {
          this.appendMemoryCommitRow(
            `t${event.turn} compacted long-term memory x${event.applied.journalCompactions}`,
          );
        }

        this.renderFrame();
        return;
      case "LLM_REQUEST_COMPLETED":
        this.drainThinkingBuffer(true);
        this.llmStage = "done";
        this.appendRecentLlmRow(this.buildCompletedRow(event));
        this.renderFrame();
        return;
      case "LLM_REQUEST_FAILED":
        this.drainThinkingBuffer(true);
        this.llmStage = "error";
        this.appendRecentLlmRow(this.buildFailedRow(event));
        this.renderFrame();
        return;
    }
  }
}
