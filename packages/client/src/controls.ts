import type { Direction, EntityState, Intent, Interaction } from '@game/shared';
import { isStatsComponent } from '@game/shared';
import type { Game, WorldState } from './game.ts';
import { actionFor, entityName, type EntityAction } from './interactions.ts';
import { chebyshev, findPath, type Tile } from './pathfind.ts';

/**
 * Player input: hold-to-walk, click-to-move, click-to-act and Space to use
 * whatever is in reach. Movement stays one tile per intent; the controller
 * paces intents to one step every STEP_TICKS server ticks, sent right after a
 * snapshot so each lands at the start of the next tick, which keeps the
 * cadence regular enough for the renderer to slide between tiles without
 * stopping.
 */

const STEP_TICKS = 2;
/** Wall-clock floor between steps, so a burst of late snapshots cannot fire a volley. */
const STEP_MIN_MS = 170;
/** Matches combat's player swing cooldown. */
const ATTACK_TICKS = 7;
/** A step that has not shown up after this many ticks is treated as blocked. */
const STUCK_TICKS = 4;
const REPATH_TICKS = 3;
const STRIDE = 100;

const KEY_DIRS: Record<string, Direction> = {
  ArrowUp: 'n',
  ArrowDown: 's',
  ArrowRight: 'e',
  ArrowLeft: 'w',
  KeyW: 'n',
  KeyS: 's',
  KeyD: 'e',
  KeyA: 'w',
};

interface PendingAction {
  targetId: number;
  action: EntityAction;
}

export interface Prompt {
  key: string;
  verb: string;
  name: string;
}

export interface ControlsView {
  hoveredId: number | null;
  targetId: number | null;
  prompt: Prompt | null;
  mouseX: number;
  mouseY: number;
}

export class Controls {
  readonly view: ControlsView = {
    hoveredId: null,
    targetId: null,
    prompt: null,
    mouseX: 0,
    mouseY: 0,
  };
  private readonly held: Direction[] = [];
  private path: Tile[] | null = null;
  private destination: Tile | null = null;
  private pending: PendingAction | null = null;
  private lastStepTick = -100;
  private lastStepAt = 0;
  private lastAttackTick = -100;
  private lastPathTick = -100;
  private sentFrom: Tile | null = null;
  private repaths = 0;
  private world = '';
  private tick = 0;
  private hoverTile: Tile | null = null;
  /** True while a dialog or text field owns the keyboard. */
  keyboardLocked = false;

  constructor(
    private readonly game: Game,
    private readonly send: (intent: Intent) => void,
    private readonly notify: (text: string) => void,
  ) {
    game.onSnapshot((state) => this.onSnapshot(state));
    game.setPointerSink({
      entity: (id, type) => this.onEntityPointer(id, type),
      ground: (x, y) => this.onGround(x, y),
      hoverTile: (x, y) => {
        this.hoverTile = { x, y };
      },
    });
    const canvas = game.canvas();
    canvas.addEventListener('pointermove', (e) => {
      const rect = canvas.getBoundingClientRect();
      this.view.mouseX = e.clientX - rect.left;
      this.view.mouseY = e.clientY - rect.top;
    });
    canvas.addEventListener('pointerleave', () => {
      this.hoverTile = null;
      this.setHovered(null);
    });
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());
    window.addEventListener('keydown', (e) => this.onKeyDown(e));
    window.addEventListener('keyup', (e) => this.onKeyUp(e));
    window.addEventListener('blur', () => (this.held.length = 0));
  }

  private me(): EntityState | undefined {
    return this.game.localPlayer();
  }

  private setHovered(id: number | null): void {
    this.view.hoveredId = id;
    this.game.setHovered(id);
  }

  private setTarget(id: number | null): void {
    this.view.targetId = id;
    this.game.setTarget(id);
  }

  /** Cancel any click-driven movement and pending action. */
  stop(clearTarget = true): void {
    this.path = null;
    this.destination = null;
    this.pending = null;
    this.game.setMarker(null);
    if (clearTarget) this.setTarget(null);
  }

  private onEntityPointer(id: number, type: 'tap' | 'over' | 'out'): void {
    if (type === 'over') return this.setHovered(id);
    if (type === 'out') {
      if (this.view.hoveredId === id) this.setHovered(null);
      return;
    }
    const entity = this.game.entity(id);
    if (!entity) return;
    const action = actionFor(entity, this.game.state.localEntityId);
    if (action.type === 'none') {
      const tile = this.hoverTile ?? { x: entity.x, y: entity.y };
      this.onGround(tile.x, tile.y);
      return;
    }
    this.engage(entity, action);
  }

  private engage(entity: EntityState, action: EntityAction): void {
    this.held.length = 0;
    this.path = null;
    this.destination = null;
    this.game.setMarker(null);
    this.pending = { targetId: entity.id, action };
    this.repaths = 0;
    if (action.type === 'attack' || action.type === 'interact') this.setTarget(entity.id);
    this.advance();
  }

  private onGround(x: number, y: number): void {
    const me = this.me();
    if (!me) return;
    this.stop();
    if (!this.game.walkable(x, y)) {
      // Clicking a wall or the lake walks to the nearest reachable edge of it.
      const path = findPath(
        me,
        { x, y },
        (gx, gy) => chebyshev({ x: gx, y: gy }, { x, y }) <= 1,
        (wx, wy) => this.game.walkable(wx, wy),
        2500,
      );
      if (!path) return;
      this.beginPath(path, path.length > 0 ? path[path.length - 1] : { x: me.x, y: me.y });
      return;
    }
    const path = findPath(
      me,
      { x, y },
      (gx, gy) => gx === x && gy === y,
      (wx, wy) => this.game.walkable(wx, wy),
    );
    if (!path) {
      this.notify("You can't find a way there.");
      return;
    }
    this.beginPath(path, { x, y });
  }

  private beginPath(path: Tile[], destination: Tile): void {
    this.path = path;
    this.destination = destination;
    this.repaths = 0;
    this.game.setMarker(path.length > 0 ? destination : null);
    this.advance();
  }

  private onKeyDown(e: KeyboardEvent): void {
    if (e.target instanceof Element && e.target.closest('#ui-overlay input, #ui-overlay textarea')) return;
    if (this.keyboardLocked) return;
    const dir = KEY_DIRS[e.code];
    if (dir) {
      e.preventDefault();
      if (e.shiftKey) {
        if (!e.repeat) this.send({ t: 'intent', kind: 'move', dir, dist: STRIDE });
        return;
      }
      if (!this.held.includes(dir)) this.held.push(dir);
      if (this.path || this.pending) this.stop(false);
      if (!e.repeat) this.advance();
      return;
    }
    if (e.repeat) return;
    if (e.code === 'Space' || e.code === 'KeyE') {
      e.preventDefault();
      this.useNearest();
    } else if (e.code === 'Tab') {
      e.preventDefault();
      this.targetNearestHostile();
    } else if (e.code === 'Escape') {
      this.stop();
    }
  }

  private onKeyUp(e: KeyboardEvent): void {
    const dir = KEY_DIRS[e.code];
    if (!dir) return;
    const i = this.held.indexOf(dir);
    if (i >= 0) this.held.splice(i, 1);
  }

  /** Space: the nearest thing in reach that has a use, else what lies underfoot. */
  private useNearest(): void {
    const best = this.nearestUsable(4);
    if (best) this.engage(best.entity, best.action);
  }

  private nearestUsable(maxDist: number): { entity: EntityState; action: EntityAction } | null {
    const me = this.me();
    if (!me) return null;
    let best: { entity: EntityState; action: EntityAction; d: number } | null = null;
    for (const entity of this.game.entities()) {
      if (entity.id === me.id) continue;
      const d = chebyshev(me, entity);
      if (d > maxDist) continue;
      const action = actionFor(entity, me.id);
      if (action.type !== 'interact' && action.type !== 'pickup') continue;
      const rank = d + (action.type === 'pickup' ? 0.5 : 0);
      if (!best || rank < best.d) best = { entity, action, d: rank };
    }
    return best;
  }

  private targetNearestHostile(): void {
    const me = this.me();
    if (!me) return;
    let best: EntityState | null = null;
    let bestD = 12;
    for (const entity of this.game.entities()) {
      if (actionFor(entity, me.id).type !== 'attack') continue;
      if (!isHostile(entity)) continue;
      const d = chebyshev(me, entity);
      if (d < bestD) {
        bestD = d;
        best = entity;
      }
    }
    if (best) this.engage(best, { type: 'attack' });
    else this.notify('No enemies nearby.');
  }

  private onSnapshot(state: WorldState): void {
    this.tick = state.tick;
    if (state.world !== this.world) {
      this.world = state.world;
      this.stop();
    }
    if (this.view.targetId !== null && !this.game.entity(this.view.targetId)) this.setTarget(null);
    this.retaliate();
    this.updatePrompt();
    this.advance();
  }

  /** Standing idle while something bites you: bite back. */
  private retaliate(): void {
    if (this.pending || this.path || this.held.length > 0) return;
    const me = this.me();
    if (!me) return;
    for (const entity of this.game.entities()) {
      if (chebyshev(me, entity) > 1 || !isHostile(entity)) continue;
      const npc = entity.components.npc as { state?: string; target?: number } | undefined;
      if (npc?.state !== 'chasing' || npc.target !== me.id) continue;
      this.engage(entity, { type: 'attack' });
      return;
    }
  }

  private updatePrompt(): void {
    const me = this.me();
    const near = me ? this.nearestUsable(1) : null;
    if (!near) {
      this.view.prompt = null;
      return;
    }
    const verb =
      near.action.type === 'interact'
        ? near.action.interaction.label
        : near.action.type === 'pickup'
          ? 'Pick up'
          : '';
    this.view.prompt = { key: 'Space', verb, name: entityName(near.entity) };
  }

  /**
   * One decision point per snapshot (and immediately on new input): act on a
   * target in range, otherwise take the next step if the pacing allows.
   */
  private advance(): void {
    const me = this.me();
    if (!me) return;

    if (this.pending && this.handlePending(me)) return;

    if (this.tick - this.lastStepTick < STEP_TICKS) return;
    const now = performance.now();
    if (now - this.lastStepAt < STEP_MIN_MS) return;

    const dir = this.nextDirection(me);
    if (!dir) return;
    this.send({ t: 'intent', kind: 'move', dir });
    this.lastStepTick = this.tick;
    this.lastStepAt = now;
    this.sentFrom = { x: me.x, y: me.y };
  }

  /** Returns true when the action consumed this decision (no step this time). */
  private handlePending(me: EntityState): boolean {
    const pending = this.pending!;
    const target = this.game.entity(pending.targetId);
    if (!target) {
      this.stop();
      return false;
    }
    const range = rangeOf(pending.action);
    const dist = chebyshev(me, target);
    if (dist <= range) {
      this.path = null;
      this.game.setMarker(null);
      switch (pending.action.type) {
        case 'interact':
          this.send({ t: 'intent', kind: pending.action.interaction.intent, targetId: target.id });
          this.pending = null;
          return true;
        case 'pickup':
          this.send({ t: 'intent', kind: 'pickup' });
          this.pending = null;
          return true;
        case 'attack':
          if (this.tick - this.lastAttackTick >= ATTACK_TICKS) {
            this.send({ t: 'intent', kind: 'combat:attack', targetId: target.id });
            this.lastAttackTick = this.tick;
          }
          return true;
        default:
          this.pending = null;
          return false;
      }
    }
    const goalMoved =
      !this.destination || this.destination.x !== target.x || this.destination.y !== target.y;
    if (!this.path || (goalMoved && this.tick - this.lastPathTick >= REPATH_TICKS)) {
      const path = findPath(
        me,
        target,
        (gx, gy) => chebyshev({ x: gx, y: gy }, target) <= range,
        (wx, wy) => this.game.walkable(wx, wy),
      );
      this.lastPathTick = this.tick;
      if (!path) {
        this.notify(`You can't reach ${entityName(target)}.`);
        this.stop();
        return true;
      }
      this.path = path;
      this.destination = { x: target.x, y: target.y };
    }
    return false;
  }

  private nextDirection(me: EntityState): Direction | undefined {
    if (this.held.length > 0) return this.held[this.held.length - 1];
    if (!this.path) return undefined;

    const at = this.path.findIndex((p) => p.x === me.x && p.y === me.y);
    if (at >= 0) {
      this.path = this.path.slice(at + 1);
    } else if (this.sentFrom && this.sentFrom.x === me.x && this.sentFrom.y === me.y) {
      // The last step has not landed: wait a little, then assume a wall.
      if (this.tick - this.lastStepTick < STUCK_TICKS) return undefined;
      if (!this.repath(me)) return undefined;
    }
    if (this.path.length === 0) {
      if (!this.pending) {
        this.path = null;
        this.destination = null;
        this.game.setMarker(null);
      }
      return undefined;
    }
    const next = this.path[0];
    const dx = next.x - me.x;
    const dy = next.y - me.y;
    if ((dx === 0) === (dy === 0) || dx * dx > 1 || dy * dy > 1) {
      if (!this.repath(me)) return undefined;
      return this.nextDirection(me);
    }
    return dx === 1 ? 'e' : dx === -1 ? 'w' : dy === 1 ? 's' : 'n';
  }

  private repath(me: EntityState): boolean {
    const goal = this.destination;
    if (!goal || ++this.repaths > 3) {
      this.stop(false);
      return false;
    }
    const range = this.pending ? rangeOf(this.pending.action) : 0;
    const path = findPath(
      me,
      goal,
      (gx, gy) => chebyshev({ x: gx, y: gy }, goal) <= range,
      (wx, wy) => this.game.walkable(wx, wy),
    );
    if (!path) {
      this.stop(false);
      return false;
    }
    // An empty path means we are already in range: keep any pending action.
    this.path = path;
    return true;
  }
}

function rangeOf(action: EntityAction): number {
  if (action.type === 'interact') return (action.interaction as Interaction).range ?? 1;
  if (action.type === 'pickup') return 0;
  return 1;
}

/** Monsters announce themselves with a `hostile` flag; villagers fight only when hit. */
export function isHostile(entity: EntityState): boolean {
  return entity.components.hostile === true || entity.components.monster !== undefined;
}

export function levelOf(entity: EntityState): number | undefined {
  const stats = entity.components.stats;
  return isStatsComponent(stats) ? stats.level : undefined;
}

