import { OVERWORLD, interiorWorldId, type WorldAPI } from '@game/shared';

export interface HouseStyle {
  frame: string;
  scale: number;
  originX: number;
  originY: number;
  left: number;
  right: number;
  depth: number;
}

export const HOUSE_STYLES: readonly HouseStyle[] = [
  { frame: 'buildings/cottage', scale: 1.5, originX: 40, originY: 96, left: 1, right: 1, depth: 2 },
  {
    frame: 'buildings/storehouse',
    scale: 1.5,
    originX: 40,
    originY: 80,
    left: 1,
    right: 1,
    depth: 2,
  },
  { frame: 'buildings/barn', scale: 1.25, originX: 64, originY: 80, left: 2, right: 1, depth: 2 },
];

export function placeHouse(
  world: WorldAPI,
  x: number,
  y: number,
  style: HouseStyle,
  label: string,
): void {
  // Roofs extend above the footprint; only the walls at ground level collide.
  for (let dy = -style.depth; dy <= 0; dy++) {
    for (let dx = -style.left; dx <= style.right; dx++) {
      world.setTile(x + dx, y + dy, dy === 0 && dx === 0 ? 'dirt' : 'wall');
    }
  }
  world.setTile(x, y + 1, 'dirt');
  if (world.queryNear(x, y, 0, OVERWORLD).some((e) => e.kind === 'buildings:door')) return;
  world.spawn(
    'buildings:door',
    { x, y },
    {
      door: { toWorld: interiorWorldId(x, y), backX: x, backY: y + 1 },
      appearance: {
        frame: style.frame,
        scale: style.scale,
        originX: style.originX,
        originY: style.originY,
      },
      label,
    },
    OVERWORLD,
  );
}

function prop(
  world: WorldAPI,
  dx: number,
  dy: number,
  frame: string,
  scale = 1,
  label?: string,
): void {
  const x = world.width / 2 + dx;
  const y = world.height / 2 + dy;
  if (world.queryNear(x, y, 0).some((e) => e.kind === 'buildings:prop')) return;
  world.spawn(
    'buildings:prop',
    { x, y },
    { appearance: { frame, scale }, ...(label ? { label } : {}) },
    OVERWORLD,
  );
}

/** A small amount of work per tick, so village generation respects the budget. */
export function* buildVillage(world: WorldAPI): Generator<void> {
  const cx = world.width / 2;
  const cy = world.height / 2;
  for (let dy = -22; dy <= 22; dy++) {
    for (let dx = -22; dx <= 22; dx++) {
      const x = cx + dx;
      const y = cy + dy;
      let tile = 'grass';
      // Woodland to the west, rocky highlands to the north, a lake east of town.
      if (dx < -12) tile = 'forest';
      if (dy < -16 && (dx < -4 || dx > 4)) tile = dy < -20 ? 'snow' : 'mountain';
      const lake = (dx - 16) * (dx - 16) * 16 + dy * dy * 36;
      if (lake < 36 * 16) tile = 'water';
      else if (lake < 64 * 25) tile = 'sand';
      if (dx > 12 && dy > 10) tile = 'swamp';
      // Roads stay continuous through the settlement and up to the wilderness.
      if ((dx >= -1 && dx <= 1) || (dy >= -1 && dy <= 1 && dx < 11)) tile = 'dirt';
      if (dy >= 9 && dy <= 14 && dx >= -3 && dx <= 3) tile = 'dirt';
      world.setTile(x, y, tile);
    }
    yield;
  }

  const houses = [
    { x: -7, y: -4, style: 0, label: 'Wayside Inn' },
    { x: 7, y: -4, style: 1, label: 'Alchemist' },
    { x: -7, y: 7, style: 2, label: 'Storehouse' },
    { x: 7, y: 7, style: 0, label: 'Farmhouse' },
  ];
  for (const house of houses) {
    placeHouse(world, cx + house.x, cy + house.y, HOUSE_STYLES[house.style], house.label);
    // Front paths connect every entrance to the east/west road.
    if (house.y < 0) {
      for (let y = house.y + 1; y <= -1; y++) world.setTile(cx + house.x, cy + y, 'dirt');
    } else {
      // Approach southern buildings around the side, not through their walls.
      for (let y = 1; y <= house.y + 1; y++) world.setTile(cx + house.x + 3, cy + y, 'dirt');
      for (let x = house.x; x <= house.x + 3; x++) world.setTile(cx + x, cy + house.y + 1, 'dirt');
    }
    yield;
  }

  const props: [number, number, string, number, string?][] = [
    [-3, 6, 'objects/well', 1.2, 'Village well'],
    [-10, -2, 'objects/barrel', 1],
    [-9, -2, 'objects/barrel', 1],
    [9, -2, 'objects/barrel', 1],
    [4, 8, 'objects/stump', 1],
    [-11, 8, 'objects/boulder', 1],
    [11, 3, 'objects/small-rock', 1.5],
    [-4, 10, 'objects/fence', 2],
    [-4, 11, 'objects/fence', 2],
    [-4, 12, 'objects/fence', 2],
    [4, 10, 'objects/fence', 2],
    [4, 11, 'objects/fence', 2],
    [4, 12, 'objects/fence', 2],
    [-10, 3, 'objects/tree', 1.2],
    [10, 9, 'objects/tree', 1.2],
    [-4, -7, 'objects/tree', 1],
    [4, -7, 'objects/tree', 1],
  ];
  for (const [x, y, frame, scale, label] of props) {
    prop(world, x, y, frame, scale, label);
    yield;
  }
  // Crops use the extracted plant sprites, kept separate from walkable terrain.
  for (let y = 10; y <= 13; y++) {
    for (const x of [-2, 2]) prop(world, x, y, 'objects/crop', 1.25);
    yield;
  }
  world.log('built starting village: four houses, roads, lake, fields, and props');
  world.emit('buildings:village-ready', { x: cx, y: cy });
}
