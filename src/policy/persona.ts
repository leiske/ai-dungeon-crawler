export interface PersonaDefinition {
  id: string;
  description: string;
  temperature: number;
  systemDirectives: readonly string[];
  turnDirectives: readonly string[];
}

const CAUTIOUS_SCOUT_PERSONA: PersonaDefinition = {
  id: "cautious-scout",
  description:
    "Survival-first explorer that avoids unnecessary fights and advances safely toward the exit.",
  temperature: 0.3,
  systemDirectives: [
    "You are a cautious scout in a hostile dungeon.",
    "Your personality is careful, observant, and survival-focused.",
    "You avoid reckless behavior and prefer controlled progress.",
  ],
  turnDirectives: [
    "Stay in character as a cautious scout when choosing this turn's action.",
    "Balance survival, uncertainty, and forward progress toward the exit.",
    "Use memory and recent movement history to avoid getting stuck in repetitive behavior.",
  ],
};

const AGGRESSIVE_BARBARIAN_PERSONA: PersonaDefinition = {
  id: "aggressive-barbarian",
  description:
    "Relentless frontliner that pressures nearby enemies and accepts higher risk to keep momentum.",
  temperature: 0.8,
  systemDirectives: [
    "You are an aggressive barbarian with bloodlust.",
    "Your personality is bold, confrontational, and action-first.",
    "You seek domination of nearby threats and disdain timid play.",
  ],
  turnDirectives: [
    "Stay in character as an aggressive barbarian when choosing this turn's action.",
    "Act with relentless pressure while still pursuing the dungeon objective.",
    "Use memory and recent movement history to maintain momentum and avoid dithering.",
  ],
};

const PERSONAS: readonly PersonaDefinition[] = [
  CAUTIOUS_SCOUT_PERSONA,
  AGGRESSIVE_BARBARIAN_PERSONA,
];

export const DEFAULT_PERSONA_ID = CAUTIOUS_SCOUT_PERSONA.id;

const PERSONAS_BY_ID = new Map(PERSONAS.map((persona) => [persona.id, persona]));

function clonePersonaDefinition(persona: PersonaDefinition): PersonaDefinition {
  return {
    id: persona.id,
    description: persona.description,
    temperature: persona.temperature,
    systemDirectives: [...persona.systemDirectives],
    turnDirectives: [...persona.turnDirectives],
  };
}

function formatAvailablePersonaIds(): string {
  return PERSONAS.map((persona) => persona.id).join(", ");
}

export function listPersonas(): readonly PersonaDefinition[] {
  return PERSONAS.map((persona) => clonePersonaDefinition(persona));
}

export function getPersonaById(personaId: string): PersonaDefinition {
  const persona = PERSONAS_BY_ID.get(personaId);
  if (!persona) {
    throw new Error(
      `Unknown persona '${personaId}'. Available personas: ${formatAvailablePersonaIds()}.`,
    );
  }

  return clonePersonaDefinition(persona);
}
