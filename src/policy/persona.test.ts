import { expect, test } from "bun:test";
import { DEFAULT_PERSONA_ID, getPersonaById, listPersonas } from "./persona.ts";

test("default persona id resolves to cautious-scout", () => {
  expect(DEFAULT_PERSONA_ID).toBe("cautious-scout");
  expect(getPersonaById(DEFAULT_PERSONA_ID).id).toBe("cautious-scout");
});

test("persona registry exposes expected persona ids", () => {
  const personaIds = listPersonas()
    .map((persona) => persona.id)
    .sort();

  expect(personaIds).toEqual(["aggressive-barbarian", "cautious-scout"]);
});

test("personas encode different combat priorities", () => {
  const cautious = getPersonaById("cautious-scout");
  const aggressive = getPersonaById("aggressive-barbarian");

  expect(cautious.systemDirectives.join(" ")).toContain("cautious scout");
  expect(cautious.systemDirectives.join(" ")).toContain("survival-focused");
  expect(cautious.turnDirectives.join(" ")).toContain("Stay in character");

  expect(aggressive.systemDirectives.join(" ")).toContain("aggressive barbarian");
  expect(aggressive.systemDirectives.join(" ")).toContain("bloodlust");
  expect(aggressive.turnDirectives.join(" ")).toContain("Stay in character");

  expect(cautious.temperature).toBeLessThan(aggressive.temperature);
  expect(cautious.temperature).toBeGreaterThanOrEqual(0);
  expect(aggressive.temperature).toBeLessThanOrEqual(2);
});

test("persona directives avoid hard-coded action preferences", () => {
  const cautiousText = JSON.stringify(getPersonaById("cautious-scout"));
  const aggressiveText = JSON.stringify(getPersonaById("aggressive-barbarian"));

  expect(cautiousText).not.toContain("prefer ATTACK");
  expect(cautiousText).not.toContain("prefer USE_ITEM");
  expect(aggressiveText).not.toContain("prefer ATTACK");
  expect(aggressiveText).not.toContain("strongly prefer");
});

test("persona lookups return defensive copies", () => {
  const persona = getPersonaById("aggressive-barbarian");
  (persona.systemDirectives as string[]).push("tampered-system-directive");
  (persona.turnDirectives as string[]).push("tampered-turn-directive");
  persona.temperature = 0;

  const fresh = getPersonaById("aggressive-barbarian");
  expect(fresh.systemDirectives).not.toContain("tampered-system-directive");
  expect(fresh.turnDirectives).not.toContain("tampered-turn-directive");
  expect(fresh.temperature).toBe(0.8);
});

test("unknown persona id throws a useful error", () => {
  expect(() => getPersonaById("unknown-persona")).toThrow(
    /Unknown persona 'unknown-persona'. Available personas: cautious-scout, aggressive-barbarian./,
  );
});
