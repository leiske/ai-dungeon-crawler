# Project: Roguelike Tactical AI Lab (v0)

## Objective

Build a minimal, deterministic, turn-based roguelike simulation in TypeScript that runs entirely in Bun (no rendering library, no Phaser, no browser).

The goal is to create a simulation harness for AI-controlled personas. No UI beyond ASCII console output. No LLM integration yet.

Focus on correctness, determinism, and clean architecture.

---

## High-Level Requirements

### Core Principles

* Deterministic via seeded RNG.
* Pure simulation core (no side effects in reducer).
* Clear separation between:

  * State
  * Simulation logic
  * Policy (persona decision logic)
  * Runner / metrics
* Fast to simulate many runs (100+ episodes).

---

## Initial Scope (Strict)

### Map

* Fixed 15x15 grid.
* Tiles: Floor | Wall | Exit.
* Simple generator:

  * Border walls.
  * Random internal walls at low density (10–15%).
  * Ensure at least one valid path from player start to exit.
* One exit tile.

### Visibility

* Player sees tiles within Manhattan distance ≤ 2.
* No fog persistence.
* Enemies outside this radius are invisible to the policy.

---

## Entities

### Player

* id
* x, y
* hp (start 10)
* maxHp (10)
* potionCount (start 1)

### Enemy

* id
* x, y
* hp (start 5)
* attackDamage (2)
* simple AI: move toward player if adjacent or visible (global knowledge allowed for enemies in v0).

---

## Turn Model

Each turn:

1. Player action selected by policy.
2. Apply player action.
3. Resolve combat if applicable.
4. For each alive enemy:

   * Move toward player (A* or simple greedy Manhattan step).
   * If adjacent after move, attack.
5. Check win/lose conditions.
6. Increment turn counter.

Game ends when:

* Player HP ≤ 0 → Loss
* Player reaches Exit tile → Win
* Turn limit (e.g. 200) → Forced end

---

## Player Actions (Enum)

* MOVE_N
* MOVE_S
* MOVE_E
* MOVE_W
* ATTACK (if adjacent enemy)
* USE_POTION (restore 5 HP, capped at maxHp)
* WAIT

Invalid actions must be rejected and replaced with WAIT.

---

## Combat Rules

* Player attack damage: 3
* Enemy attack damage: 2
* No crits.
* Deterministic damage (no randomness yet).

---

## Architecture

### Files

rng.ts

* Seeded PRNG (mulberry32 or similar).

types.ts

* GameState
* Entity
* Tile
* Action
* Observation

sim.ts

* generateMap(seed)
* getObservation(state)
* applyAction(state, action)
* step(state, action)
* cloneState(state)

policy/heuristic.ts

* Persona definition
* scoreActions(state, observation, persona)
* chooseAction(...)

run.ts

* Run single episode
* Run N episodes with same persona
* Collect metrics

---

## Persona System

Persona = parameter object only.

Example fields:

* riskTolerance: number (0–1)
* hpPanicThreshold: number (0–1)
* aggressionBias: number (0–1)
* explorationBias: number (0–1)
* potionUseBias: number (0–1)

Heuristic policy should:

1. Enumerate all valid actions.
2. Score each action.
3. Return highest scoring.

No randomness in policy for v0.

---

## Metrics Per Run

Collect:

* win (boolean)
* turnsSurvived
* damageTaken
* damageDealt
* potionsUsed
* enemiesKilled

Export results as JSON.

---

## ASCII Rendering (Optional but Helpful)

Provide a function render(state) that prints:

* # = Wall
* . = Floor
* E = Exit
* P = Player
* M = Enemy

---

## Constraints

* No external game engines.
* No UI frameworks.
* No LLM integration.
* Keep total codebase under small for v0.
* Prefer pure functions where possible (very important).
* don't unit test

---

## Definition of Done

* Can run 100 simulations with a fixed seed.
* Deterministic results across runs.
* At least two personas with meaningfully different win rates.
* Clean, readable code.

---

Once the simulation harness is stable, we will:

1. Introduce limited randomness to combat.
2. Add multiple enemy types.
3. Integrate an LLM as an alternate policy implementation.

For now, build the lab.
