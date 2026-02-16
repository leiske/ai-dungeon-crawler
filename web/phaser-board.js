import * as Phaser from "/vendor/phaser.js";

const TILE_SIZE = 32;
const VIEWPORT_TILE_WIDTH = 19;
const VIEWPORT_TILE_HEIGHT = 15;
const VIEWPORT_WIDTH = VIEWPORT_TILE_WIDTH * TILE_SIZE;
const VIEWPORT_HEIGHT = VIEWPORT_TILE_HEIGHT * TILE_SIZE;

const UNEXPLORED_FOG_ALPHA = 0.92;
const EXPLORED_FOG_ALPHA = 0.5;

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

function toPositionKey(x, y) {
  return `${x},${y}`;
}

function manhattanDistance(ax, ay, bx, by) {
  return Math.abs(ax - bx) + Math.abs(ay - by);
}

function isInBounds(map, x, y) {
  return x >= 0 && y >= 0 && x < map.width && y < map.height;
}

function getTile(map, x, y) {
  const row = map.tiles[y];
  return row ? row[x] : undefined;
}

function isOpaqueTile(tile) {
  return tile === "WALL";
}

function hasLineOfSight(map, fromX, fromY, toX, toY) {
  if (!isInBounds(map, fromX, fromY) || !isInBounds(map, toX, toY)) {
    return false;
  }

  let currentX = fromX;
  let currentY = fromY;
  const deltaX = Math.abs(toX - fromX);
  const deltaY = Math.abs(toY - fromY);
  const stepX = fromX < toX ? 1 : -1;
  const stepY = fromY < toY ? 1 : -1;
  let error = deltaX - deltaY;

  while (currentX !== toX || currentY !== toY) {
    const previousX = currentX;
    const previousY = currentY;
    const doubledError = error * 2;
    let movedX = false;
    let movedY = false;

    if (doubledError > -deltaY) {
      error -= deltaY;
      currentX += stepX;
      movedX = true;
    }

    if (doubledError < deltaX) {
      error += deltaX;
      currentY += stepY;
      movedY = true;
    }

    if (movedX && movedY) {
      const horizontalStepTile = getTile(map, previousX + stepX, previousY);
      const verticalStepTile = getTile(map, previousX, previousY + stepY);
      if (isOpaqueTile(horizontalStepTile) && isOpaqueTile(verticalStepTile)) {
        return false;
      }
    }

    if (currentX === toX && currentY === toY) {
      return true;
    }

    if (isOpaqueTile(getTile(map, currentX, currentY))) {
      return false;
    }
  }

  return true;
}

function pickFocusPlayer(players) {
  const sorted = [...players].sort((left, right) => left.id - right.id);
  const alivePlayer = sorted.find((player) => player.hp > 0);
  return alivePlayer ?? sorted[0] ?? null;
}

function collectVisibleTileKeys(state, focusPlayer) {
  const visibleTileKeys = new Set();
  if (!focusPlayer) {
    return visibleTileKeys;
  }

  const radius = state.rules.visionRadius;
  const map = state.map;

  for (let y = focusPlayer.y - radius; y <= focusPlayer.y + radius; y += 1) {
    if (y < 0 || y >= map.height) {
      continue;
    }

    const row = map.tiles[y];
    if (!row) {
      continue;
    }

    for (let x = focusPlayer.x - radius; x <= focusPlayer.x + radius; x += 1) {
      if (x < 0 || x >= map.width) {
        continue;
      }

      if (manhattanDistance(focusPlayer.x, focusPlayer.y, x, y) > radius) {
        continue;
      }

      if (row[x] === undefined) {
        continue;
      }

      if (!hasLineOfSight(map, focusPlayer.x, focusPlayer.y, x, y)) {
        continue;
      }

      visibleTileKeys.add(toPositionKey(x, y));
    }
  }

  return visibleTileKeys;
}

function clamp(value, minValue, maxValue) {
  return Math.max(minValue, Math.min(maxValue, value));
}

export class PhaserBoardRenderer {
  constructor(container) {
    this.container = container;
    this.pendingState = null;
    this.scene = null;
    this.mapGraphics = null;
    this.fogGraphics = null;
    this.currentMapSignature = null;
    this.entities = new Map();
    this.exploredTileKeys = new Set();

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
      width: VIEWPORT_WIDTH,
      height: VIEWPORT_HEIGHT,
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
    this.exploredTileKeys.clear();

    if (this.mapGraphics) {
      this.mapGraphics.destroy();
      this.mapGraphics = null;
    }

    if (this.fogGraphics) {
      this.fogGraphics.destroy();
      this.fogGraphics = null;
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

    const mapChanged = this.ensureMapLayer(state.map);
    if (mapChanged) {
      this.exploredTileKeys.clear();
    }

    const focusPlayer = pickFocusPlayer(state.players);
    const visibleTileKeys = collectVisibleTileKeys(state, focusPlayer);
    for (const key of visibleTileKeys) {
      this.exploredTileKeys.add(key);
    }

    this.syncEntities(state.players, "player", visibleTileKeys);
    this.syncEntities(state.enemies, "enemy", visibleTileKeys);
    this.pruneEntities(state);
    this.renderFog(state.map, visibleTileKeys);
    this.updateCamera(state.map, focusPlayer);
  }

  ensureMapLayer(map) {
    const signature = mapSignature(map);
    if (signature === this.currentMapSignature && this.mapGraphics) {
      return false;
    }

    this.currentMapSignature = signature;

    if (this.mapGraphics) {
      this.mapGraphics.destroy();
      this.mapGraphics = null;
    }

    if (this.fogGraphics) {
      this.fogGraphics.destroy();
      this.fogGraphics = null;
    }

    this.updateWorldBounds(map.width, map.height);

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
    return true;
  }

  updateWorldBounds(widthTiles, heightTiles) {
    const worldWidth = widthTiles * TILE_SIZE;
    const worldHeight = heightTiles * TILE_SIZE;

    this.scene.cameras.main.setBounds(0, 0, worldWidth, worldHeight);
    this.scene.cameras.main.setViewport(0, 0, VIEWPORT_WIDTH, VIEWPORT_HEIGHT);
  }

  updateCamera(map, focusPlayer) {
    if (!focusPlayer) {
      return;
    }

    const world = toWorld(focusPlayer);
    const worldWidth = map.width * TILE_SIZE;
    const worldHeight = map.height * TILE_SIZE;
    const maxScrollX = Math.max(0, worldWidth - VIEWPORT_WIDTH);
    const maxScrollY = Math.max(0, worldHeight - VIEWPORT_HEIGHT);

    const desiredScrollX = world.x - VIEWPORT_WIDTH / 2;
    const desiredScrollY = world.y - VIEWPORT_HEIGHT / 2;

    const scrollX = clamp(desiredScrollX, 0, maxScrollX);
    const scrollY = clamp(desiredScrollY, 0, maxScrollY);
    this.scene.cameras.main.setScroll(scrollX, scrollY);
  }

  ensureFogLayer() {
    if (this.fogGraphics) {
      return this.fogGraphics;
    }

    const graphics = this.scene.add.graphics();
    graphics.setDepth(20);
    this.fogGraphics = graphics;
    return graphics;
  }

  renderFog(map, visibleTileKeys) {
    const fog = this.ensureFogLayer();
    fog.clear();

    for (let y = 0; y < map.height; y += 1) {
      for (let x = 0; x < map.width; x += 1) {
        const key = toPositionKey(x, y);
        if (visibleTileKeys.has(key)) {
          continue;
        }

        const isExplored = this.exploredTileKeys.has(key);
        fog.fillStyle(0x060606, isExplored ? EXPLORED_FOG_ALPHA : UNEXPLORED_FOG_ALPHA);
        fog.fillRect(x * TILE_SIZE, y * TILE_SIZE, TILE_SIZE, TILE_SIZE);
      }
    }
  }

  syncEntities(actors, actorKind, visibleTileKeys) {
    for (const actor of actors) {
      const key = actorKey(actorKind, actor.id);
      if (actor.hp <= 0) {
        const existing = this.entities.get(key);
        if (existing) {
          this.scene.tweens.killTweensOf(existing);
          existing.destroy();
          this.entities.delete(key);
        }
        continue;
      }

      const node = this.ensureEntity(key, actorKind);
      const world = toWorld(actor);
      const shouldShow = actorKind === "player" || visibleTileKeys.has(toPositionKey(actor.x, actor.y));

      this.scene.tweens.killTweensOf(node);

      if (!shouldShow) {
        node.setVisible(false);
        node.setPosition(world.x, world.y);
        continue;
      }

      node.setVisible(true);
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
