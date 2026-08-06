import {
  definePlugin,
  OVERWORLD,
  THEMED_WORLD_IDS,
  WORLD_CENTER_X,
  WORLD_CENTER_Y,
  resolveWorld,
  type WorldAPI,
} from '@game/shared';

/**
 * Portals: four pads at the exact centre of the overworld, one per themed
 * world, and a return pad at the centre of each of those.
 *
 * The whole feature is two ideas. `world.travel()` moves an entity between
 * worlds — core owns that, because worlds are physics. Everything here is
 * content: where the pads are, what they look like, and which way they point.
 *
 * Pads are spawned once and then persist like any other entity, so the
 * bootstrap is claimed with getSet rather than re-run every boot.
 */

/** Component carried by every pad: where it sends you. */
interface PortalComponent {
  toWorld: string;
  toX: number;
  toY: number;
}

function isPortal(value: unknown): value is PortalComponent {
  if (typeof value !== 'object' || value === null) return false;
  const p = value as Record<string, unknown>;
  return typeof p.toWorld === 'string' && typeof p.toX === 'number' && typeof p.toY === 'number';
}

/**
 * Pads sit in a ring one tile out from the centre, so the centre tile itself
 * stays walkable and you can stand between them without being teleported.
 */
const PAD_OFFSETS: readonly { x: number; y: number }[] = [
  { x: -2, y: 0 },
  { x: 2, y: 0 },
  { x: 0, y: -2 },
  { x: 0, y: 2 },
];

/** Where you land in a themed world: its own centre, beside the return pad. */
const ARRIVAL_X = WORLD_CENTER_X;
const ARRIVAL_Y = WORLD_CENTER_Y + 1;

function placePads(world: WorldAPI): void {
  THEMED_WORLD_IDS.forEach((target, index) => {
    const spec = resolveWorld(target);
    if (!spec) return;
    const offset = PAD_OFFSETS[index];

    // Outbound pad, in the overworld.
    world.spawn(
      'portals:pad',
      { x: WORLD_CENTER_X + offset.x, y: WORLD_CENTER_Y + offset.y },
      { portal: { toWorld: target, toX: ARRIVAL_X, toY: ARRIVAL_Y }, label: spec.name },
      OVERWORLD,
    );

    // Return pad, at the centre of the themed world. Without this you can get
    // there and not back, which is a trap rather than a destination.
    world.spawn(
      'portals:return',
      { x: WORLD_CENTER_X, y: WORLD_CENTER_Y },
      {
        portal: { toWorld: OVERWORLD, toX: WORLD_CENTER_X, toY: WORLD_CENTER_Y },
        label: 'Home',
      },
      target,
    );
  });
  world.log(`placed ${THEMED_WORLD_IDS.length} portal pads at the centre of the overworld`);
}

export default definePlugin({
  id: 'portals',
  entityKinds: ['portals:pad', 'portals:return'],
  items: [],
  recipes: [],

  systems: [
    {
      name: 'portals:bootstrap',
      fn: (world) => {
        // One-time: getSet claims the flag and returns the previous value, so
        // exactly one boot in the world's lifetime does the spawning.
        if (world.getSet('portals:placed', '1') !== undefined) return;
        placePads(world);
      },
    },
  ],

  events: {},

  commands: [
    {
      /**
       * Step onto a pad and send this to use it. A command rather than a
       * system: teleporting someone because they walked past would make the
       * centre of the map impossible to cross.
       */
      name: 'portals:use',
      fn: (world, _args, entityId) => {
        const self = world.get(entityId);
        if (!self) return;

        // The pad has to be the tile you are standing on, or adjacent.
        const pads = world
          .queryNear(self.x, self.y, 1, self.world)
          .filter((e) => e.kind === 'portals:pad' || e.kind === 'portals:return');
        const pad = pads[0];
        // Silent: Space is bound by several features at once, so "nothing
        // of mine here" is the normal case, not a problem worth logging.
        if (!pad) return;
        const portal = pad.components.portal;
        if (!isPortal(portal)) return;

        if (world.travel(entityId, portal.toWorld, portal.toX, portal.toY)) {
          world.log(`entity ${entityId} travelled to ${portal.toWorld}`);
        }
      },
    },
  ],
});
