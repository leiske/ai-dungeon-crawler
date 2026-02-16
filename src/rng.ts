export interface SeededRng {
  nextFloat(): number;
  nextInt(minInclusive: number, maxInclusive: number): number;
}

const UINT32_MAX_PLUS_ONE = 0x1_0000_0000;

function assertSafeInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value)) {
    throw new Error(`Expected ${name} to be a safe integer. Received ${value}.`);
  }
}

function normalizeSeed(seed: number): number {
  assertSafeInteger(seed, "seed");
  return seed >>> 0;
}

export function createSeededRng(seed: number): SeededRng {
  let state = normalizeSeed(seed);

  return {
    nextFloat(): number {
      state = (state + 0x6d2b79f5) | 0;
      let mixed = Math.imul(state ^ (state >>> 15), state | 1);
      mixed ^= mixed + Math.imul(mixed ^ (mixed >>> 7), mixed | 61);
      return ((mixed ^ (mixed >>> 14)) >>> 0) / UINT32_MAX_PLUS_ONE;
    },
    nextInt(minInclusive: number, maxInclusive: number): number {
      assertSafeInteger(minInclusive, "minInclusive");
      assertSafeInteger(maxInclusive, "maxInclusive");

      if (maxInclusive < minInclusive) {
        throw new Error(
          `Invalid integer range [${minInclusive}, ${maxInclusive}]. maxInclusive must be >= minInclusive.`,
        );
      }

      const span = maxInclusive - minInclusive + 1;
      const offset = Math.floor(this.nextFloat() * span);
      return minInclusive + offset;
    },
  };
}

export function pickRandom<T>(rng: SeededRng, values: readonly T[]): T {
  if (values.length === 0) {
    throw new Error("Cannot pick from an empty list.");
  }

  const index = rng.nextInt(0, values.length - 1);
  const value = values[index];
  if (value === undefined) {
    throw new Error(`Random index ${index} is out of bounds for list length ${values.length}.`);
  }

  return value;
}
