# Project: Roguelike Tactical AI Lab (v0)

## Objective

Build a minimal, deterministic, turn-based roguelike simulation in TypeScript that runs entirely in Bun (no rendering library, no Phaser, no browser).

The goal is to create a simulation harness for AI-controlled personas using an LLM policy. No UI beyond ASCII console output.

Focus on correctness, determinism, and clean architecture so we can later plug in an LLM policy with minimal refactoring.

---

## High-Level Requirements

### Core Principles

* Deterministic by default.
* Pure simulation core (no side effects in reducer-style state updates).
* Clear separation between:

  * State
  * Simulation logic
  * Policy (persona decision logic)
  * Runner / metrics / trace output
* Fast to simulate many runs (100+ episodes).

---

## Initial Scope (Strict)

### Scenario / Map

* Fixed 15x15 grid for v0.
* Tiles: Floor | Wall | Exit.
* One baked-in smoke-test scenario (hand-authored), defined in TypeScript.
* Scenario should be loaded from `scenario.ts` (no file IO for v0).
* Map generation is deferred. We can later replace the fixed scenario function with generator-backed output.

### Visibility

* Player sees tiles within Manhattan distance <= 2.
* No fog persistence.
* Enemies outside this radius are invisible to the policy.
* Policy receives observation only (never full hidden state).

---

## Entities

### Player

* Stored in `players: Player[]` (v0 has one player, but shape supports many)
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
* simple AI: deterministic chase (global knowledge allowed in v0)

---

## Turn Model

Each turn:

1. Build player observation and choose player action(s) via policy (runner-owned, async).
2. Apply player phase in ascending player id order.
3. For each alive enemy in ascending enemy id order:

   * Runner asks enemy controller for that enemy action.
   * Sim applies that enemy action immediately.
4. Finalize the turn in sim:

   * Increment turn counter.
   * Evaluate end conditions.

Game ends when:

* Player HP <= 0 -> Loss
* Player reaches Exit tile while alive -> Win
* Turn limit (e.g. 200) -> Forced end

End-condition precedence:

* Loss overrides win (player must be alive to win).
* Even if a player reaches exit during player phase, the enemy phase still executes before final outcome check.

---

## Player Actions (Discriminated Union)

Use a discriminated-union action model instead of flattened enums so actions can carry additional structured fields in future iterations.

Current v0 action kinds:

* `{ kind: "MOVE", direction: "N" | "S" | "E" | "W" }`
* `{ kind: "ATTACK", direction: "N" | "S" | "E" | "W" }`
* `{ kind: "USE_ITEM", item: "POTION" }` (restore 5 HP, capped at maxHp)
* `{ kind: "WAIT" }`

Invalid actions must be rejected and replaced with WAIT.

Examples of invalid actions:

* Move into wall
* Move into occupied tile
* Attack direction with no adjacent enemy
* Use potion with no potion left

---

## Determinism Rules

* All tie breaks must use fixed ordering.
* Action preference fallback order (semantic order, regardless of object shape):

  1. MOVE N
  2. MOVE S
  3. MOVE E
  4. MOVE W
  5. ATTACK N
  6. ATTACK S
  7. ATTACK E
  8. ATTACK W
  9. USE_ITEM POTION
  10. WAIT

* Enemy move tie-break order: N, S, E, W.
* Enemy and player iteration order: ascending id.
* Enemy action resolution is sequential (decide then apply per enemy id), not batch resolved.

---

## Combat Rules

* Player attack damage: 3
* Enemy attack damage: 2
* No crits.
* Deterministic damage (no randomness in v0).

---

## Architecture

### Files

`rng.ts`

* Seeded PRNG (mulberry32 or similar).
* Note: v0 smoke scenario may not consume RNG yet.

`types.ts`

* GameState
* Entity
* Tile
* Action
* Observation
* Metrics
* Intent / phase result types

`scenario.ts`

* `createFixedScenario()` returns map + starting entities + exit + limits.
* This is the current seam for future map generation.

`sim.ts`

* `applyPlayerPhase(state, playerActions)`
* `applyEnemyAction(state, enemyId, action)`
* `finalizeTurn(state)`
* `cloneState(state)`
* Pure transition logic only (no policy/controller calls)

`observation.ts`

* `getObservation(state, playerId)`
* Visibility filtering and policy-safe projection

`policy/types.ts`

* `PlayerPolicy` interface
* `chooseAction(observation): Promise<Action>`

`enemy/types.ts`

* `EnemyController` interface
* `chooseAction(state, enemyId): EnemyAction`

`policy/llm.ts`

* LLM-backed policy implementation for v0
* Maps observation -> model prompt -> structured action output
* `chooseAction(observation): Promise<Action>`

`enemy/greedy.ts`

* Deterministic greedy enemy controller for v0

`run.ts`

* Run single episode
* Run N episodes with same persona
* Orchestrate phase loop (policy/controller decisions outside sim)
* Collect metrics + optional trace
* Export results as JSON

---

## Observation Contract

Policy receives only:

* Visible tiles
* Visible entities on those tiles
* Player current stats
* Turn count
* Absolute coordinates (x, y)

Policy does not receive hidden map state or off-vision entities.

---

## Persona System

Persona is represented by prompt/context configuration for the LLM policy.

Examples of persona controls:

* System prompt framing
* Goal/priority weighting in prompt instructions
* Safety/consistency constraints

`chooseAction` is async and model-backed in v0.

For deterministic simulation validation, the sim core remains deterministic; policy variability is isolated to runner-owned policy selection.

---

## Metrics Per Run

Collect:

* win (boolean)
* turnsSurvived
* damageTaken
* damageDealt
* potionsUsed
* enemiesKilled

Metrics are updated at the point of state transition (when the event occurs).

Export results as JSON.

---

## ASCII Rendering (Optional but Helpful)

Provide a function `render(state)` that prints:

* `#` = Wall
* `.` = Floor
* `E` = Exit
* `P` = Player
* `M` = Enemy

---

## Constraints

* No external game engines.
* No UI frameworks.
* Keep total codebase small for v0.
* Prefer pure functions where possible (very important).
* No unit tests in v0.

---

## Definition of Done (v0)

* Can run 100 simulations of the fixed smoke scenario.
* Deterministic results across repeated runs.
* At least two LLM persona configurations can be executed through the same harness.
* Clean, readable code.

Note on seeds in v0:

* If no RNG is consumed (fixed scenario + deterministic rules), changing seeds will not change outcomes. This is expected for smoke validation.

---

## Next After v0

1. Swap fixed scenario with map generation.
2. Introduce limited randomness to combat.
3. Add multiple enemy types.
4. Integrate an LLM as an alternate policy implementation.

For now, build the lab.

---

## Decision Log (2026-02-14)

* Use discriminated-union actions (`MOVE`/`ATTACK` with `direction`) rather than flattened directional enums, so action payloads can evolve cleanly.
* Invalid actions (including blocked movement / invalid attacks) become WAIT.
* Entities cannot move into occupied tiles; enemies cannot stack.
* Loss overrides win if both could trigger in same turn.
* End checks happen after full turn resolution.
* Observation-only policy input is required to prevent hidden-state cheating.
* `chooseAction` must be async and awaited in the main loop.
* Start with one fixed deterministic smoke scenario in TypeScript.
* Use phase-based orchestration: decide player -> apply player phase -> decide/apply enemies sequentially -> finalize turn.
* Keep policy and enemy controller invocations in runner, not in sim core.
* Start with `players: Player[]` state shape to avoid future multi-player refactors.
