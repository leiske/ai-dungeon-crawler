import * as Phaser from "/vendor/phaser.js";

const TILE_SIZE = 32;

const TILE_COLORS = {
  FLOOR: 0x8e8e8e,
  WALL: 0xc74242,
  EXIT: 0xe0bc3e,
};

const ENTITY_COLORS = {
  player: 0x3caf58,
  enemy: 0x2f7edb,
};

const SCENE_KEY = "board";

function mapSignature(map) {
  const tileRows = map.tiles.map((row) => row.join("")).join("|");
  return `${map.width}x${map.height}:${tileRows}`;
}

function toWorld(position) {
  return {
    x: position.x * TILE_SIZE + TILE_SIZE / 2,
    y: position.y * TILE_SIZE + TILE_SIZE / 2,
  };
}

function actorKey(kind, id) {
  return `${kind}:${id}`;
}

export class PhaserBoardRenderer {
  constructor(container) {
    this.container = container;
    this.pendingState = null;
    this.scene = null;
    this.mapGraphics = null;
    this.currentMapSignature = null;
    this.entities = new Map();

    const renderer = this;
    const sceneConfig = {
      key: SCENE_KEY,
      create() {
        this.cameras.main.setRoundPixels(true);
        renderer.onSceneReady(this);
      },
    };

    this.game = new Phaser.Game({
      type: Phaser.AUTO,
      parent: container,
      width: TILE_SIZE,
      height: TILE_SIZE,
      backgroundColor: "#1a1410",
      render: {
        antialias: false,
        pixelArt: true,
      },
      scene: [sceneConfig],
    });
  }

  onSceneReady(scene) {
    this.scene = scene;
    if (this.pendingState) {
      this.renderState(this.pendingState);
    }
  }

  reset() {
    this.pendingState = null;
    this.currentMapSignature = null;

    if (this.mapGraphics) {
      this.mapGraphics.destroy();
      this.mapGraphics = null;
    }

    for (const entity of this.entities.values()) {
      entity.destroy();
    }
    this.entities.clear();
  }

  applyState(state) {
    this.pendingState = state;
    if (!this.scene) {
      return;
    }

    this.renderState(state);
  }

  renderState(state) {
    if (!this.scene || !state || !state.map) {
      return;
    }

    this.ensureMapLayer(state.map);
    this.syncEntities(state.players, "player");
    this.syncEntities(state.enemies, "enemy");
    this.pruneEntities(state);
  }

  ensureMapLayer(map) {
    const signature = mapSignature(map);
    if (signature === this.currentMapSignature && this.mapGraphics) {
      return;
    }

    this.currentMapSignature = signature;

    if (this.mapGraphics) {
      this.mapGraphics.destroy();
      this.mapGraphics = null;
    }

    this.resizeCanvas(map.width, map.height);

    const graphics = this.scene.add.graphics();
    graphics.setDepth(0);

    for (let y = 0; y < map.height; y += 1) {
      const row = map.tiles[y];
      if (!row) {
        continue;
      }

      for (let x = 0; x < map.width; x += 1) {
        const tile = row[x];
        const fill = TILE_COLORS[tile] ?? TILE_COLORS.FLOOR;

        graphics.fillStyle(fill, 1);
        graphics.fillRect(x * TILE_SIZE, y * TILE_SIZE, TILE_SIZE, TILE_SIZE);

        graphics.lineStyle(1, 0x000000, 0.2);
        graphics.strokeRect(x * TILE_SIZE, y * TILE_SIZE, TILE_SIZE, TILE_SIZE);
      }
    }

    this.mapGraphics = graphics;
  }

  resizeCanvas(widthTiles, heightTiles) {
    const width = widthTiles * TILE_SIZE;
    const height = heightTiles * TILE_SIZE;

    this.game.scale.resize(width, height);
    this.scene.cameras.main.setBounds(0, 0, width, height);
    this.scene.cameras.main.setViewport(0, 0, width, height);
  }

  syncEntities(actors, actorKind) {
    for (const actor of actors) {
      const key = actorKey(actorKind, actor.id);
      if (actor.hp <= 0) {
        const existing = this.entities.get(key);
        if (existing) {
          existing.destroy();
          this.entities.delete(key);
        }
        continue;
      }

      const node = this.ensureEntity(key, actorKind);
      const world = toWorld(actor);

      this.scene.tweens.killTweensOf(node);
      this.scene.tweens.add({
        targets: node,
        x: world.x,
        y: world.y,
        duration: 120,
        ease: "Linear",
      });
    }
  }

  ensureEntity(key, actorKind) {
    const existing = this.entities.get(key);
    if (existing) {
      return existing;
    }

    const color = ENTITY_COLORS[actorKind];
    const node = this.scene.add.circle(0, 0, TILE_SIZE * 0.33, color, 1);
    node.setStrokeStyle(2, 0x0f0f0f, 0.9);
    node.setDepth(10);

    this.entities.set(key, node);
    return node;
  }

  pruneEntities(state) {
    const aliveKeys = new Set();

    for (const player of state.players) {
      if (player.hp > 0) {
        aliveKeys.add(actorKey("player", player.id));
      }
    }

    for (const enemy of state.enemies) {
      if (enemy.hp > 0) {
        aliveKeys.add(actorKey("enemy", enemy.id));
      }
    }

    for (const [key, node] of this.entities) {
      if (aliveKeys.has(key)) {
        continue;
      }

      this.scene.tweens.killTweensOf(node);
      node.destroy();
      this.entities.delete(key);
    }
  }
}
