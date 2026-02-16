# ai-dungeon-crawler

Observe an AI work through a dungeon crawler as the player

Turn based gameplay

Simple goal: Get to the exit alive

I am vibe coding this, apologies

```bash
bun install
```

To run:

```bash
bun run index.ts
```

Web viewer (Elysia + SSE):

```bash
bun run web
```

Then open http://localhost:3000

Select a persona:

```bash
bun run index.ts --persona cautious-scout --max-turns 5
```

Try an aggressive style:

```bash
bun run index.ts --persona aggressive-barbarian --max-turns 5
```

Try the caveman persona:

```bash
bun run index.ts --persona caveman --max-turns 5
```

This project was created using `bun init` in bun v1.3.0. [Bun](https://bun.com) is a fast all-in-one JavaScript runtime.
