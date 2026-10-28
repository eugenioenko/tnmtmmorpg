/**
 * Private components: a feature can declare components that only the owning
 * player's connection receives. Snapshots must strip them from every other
 * entity while leaving the owner's own copy, and everything else, intact.
 */
import { buildSnapshot, setPrivateComponents } from './snapshot.ts';
import { World } from './world.ts';

let failed = 0;

function ok(label: string, cond: boolean): void {
  if (cond) {
    console.log(`  ok - ${label}`);
  } else {
    failed++;
    console.log(`  NOT OK - ${label}`);
  }
}

const world = new World(1000, 1000, 7);
const alice = world.spawn('player', { x: 500, y: 500 }, {
  player: true,
  'test:secret': { whisper: 'for alice' },
  'test:public': { mood: 'cheerful' },
});
const bob = world.spawn('player', { x: 502, y: 500 }, {
  player: true,
  'test:secret': { whisper: 'for bob' },
});

setPrivateComponents(new Set(['test:secret']));

const seenBy = (viewer: number, subject: number): Record<string, unknown> | undefined => {
  const entity = world.get(viewer);
  if (!entity) return undefined;
  const snap = buildSnapshot(world, entity, 1, [], `s${viewer}`);
  return snap.entities.find((e) => e.id === subject)?.components;
};

const aliceSelf = seenBy(alice, alice);
const aliceAsBob = seenBy(bob, alice);
ok('the owner receives its private component', aliceSelf?.['test:secret'] !== undefined);
ok('another player does not', aliceAsBob !== undefined && !('test:secret' in aliceAsBob));
ok('public components still reach other players', aliceAsBob?.['test:public'] !== undefined);
ok(
  'stripping copies instead of mutating the stored entity',
  world.get(alice)?.components['test:secret'] !== undefined,
);

setPrivateComponents(new Set());
ok('with nothing declared, components pass through', seenBy(bob, alice)?.['test:secret'] !== undefined);

console.log(`\n${failed === 0 ? 'ALL PRIVATE-COMPONENT TESTS PASSED' : `${failed} FAILURE(S)`}`);
process.exit(failed === 0 ? 0 : 1);
