import {
  definePlugin,
  OVERWORLD,
  WORLD_CENTER_X,
  WORLD_CENTER_Y,
  type EntityState,
  type InventoryComponent,
  type ItemDef,
  type WorldAPI,
} from '@game/shared';

/**
 * The village's people: an elder, a guard captain, an alchemist and a trader
 * who talk, hand out a chain of quests, and buy and sell. Ordinary villagers
 * (the npc feature's wanderers) can be chatted with too.
 *
 * Conversations are a `dialog` component on the player — the client renders
 * any feature's dialog the same way, and each option carries the intent it
 * sends. Quests live in a `quests` component on the player. Kills arrive via
 * the bestiary's 'bestiary:slain'; rewards and purchases go through the
 * character feature's 'character:grant' and 'character:charge' events, so
 * this feature never touches gold or experience directly.
 */

type NpcId = 'elder' | 'captain' | 'alchemist' | 'trader';

interface Resident {
  id: NpcId;
  name: string;
  character: string;
  dx: number;
  dy: number;
  greeting: string[];
  shop?: 'gear' | 'potions';
}

const RESIDENTS: Resident[] = [
  {
    id: 'elder',
    name: 'Elder Aldous',
    character: 'villager-10',
    dx: -3,
    dy: 4,
    greeting: [
      'Ah, a fresh face. The stones at the crossroads have woken, and the wilds have grown bold.',
      'Sit, sit. My knees creak, but my ears still work. What news?',
    ],
  },
  {
    id: 'captain',
    name: 'Captain Brannoc',
    character: 'villager-14',
    dx: -5,
    dy: -2,
    greeting: [
      'Keep your blade dry and your boots laced. The beasts come closer every night.',
      'If you can swing a sword, I have work for you.',
    ],
  },
  {
    id: 'alchemist',
    name: 'Morwen the Alchemist',
    character: 'villager-11',
    dx: 9,
    dy: -1,
    greeting: [
      'Mind the jars. Some of them bite.',
      'Draughts, tonics, poultices. Nothing magical — just patience and the right roots.',
    ],
    shop: 'potions',
  },
  {
    id: 'trader',
    name: 'Odo the Trader',
    character: 'villager-12',
    dx: -3,
    dy: 8,
    greeting: [
      'Pelts, horns, feathers — I buy it all. And I sell steel at honest prices. Mostly honest.',
      'Coin for your troubles, friend?',
    ],
    shop: 'gear',
  },
];

type Goal =
  | { kind: 'slay'; species: string; count: number; label: string }
  | { kind: 'bring'; item: string; count: number; label: string }
  | { kind: 'visit'; world: string; label: string }
  | { kind: 'talk'; npc: NpcId; label: string };

interface QuestDef {
  id: string;
  title: string;
  giver: NpcId;
  /** Who you hand it in to; defaults to the giver. */
  turnIn?: NpcId;
  requires: string[];
  minLevel?: number;
  offer: string;
  done: string;
  goal: Goal;
  xp: number;
  gold: number;
  items?: [string, number][];
}

const QUESTS: QuestDef[] = [
  {
    id: 'welcome',
    title: 'A Word with the Captain',
    giver: 'elder',
    turnIn: 'captain',
    requires: [],
    offer: 'Captain Brannoc keeps the watch by the inn. He needs hands that can hold a blade. Go and speak with him — and take these draughts. You will need them.',
    done: 'The elder sent you? Good. Then let us see what you are made of.',
    goal: { kind: 'talk', npc: 'captain', label: 'Speak with Captain Brannoc' },
    xp: 25,
    gold: 10,
    items: [['character:minor_draught', 3]],
  },
  {
    id: 'hens',
    title: 'Fowl Play',
    giver: 'captain',
    requires: ['welcome'],
    offer: 'Laugh if you like, but the feral hens out past the fields have pecked two farmhands half to death. Thin them out — four should do.',
    done: 'Ha! Not bad. Take this sword; it is old, but it is sharper than your fists.',
    goal: { kind: 'slay', species: 'hen', count: 4, label: 'Slay Feral Hens' },
    xp: 60,
    gold: 20,
    items: [['character:rusty_sword', 1]],
  },
  {
    id: 'wolves',
    title: 'Wolves at the Edge',
    giver: 'captain',
    requires: ['hens'],
    offer: 'Grey wolves prowl the treeline. Six of them, and the shepherds might sleep tonight.',
    done: 'Six wolves. You are worth your bread. Wear this — it has turned a fang or two.',
    goal: { kind: 'slay', species: 'wolf', count: 6, label: 'Slay Grey Wolves' },
    xp: 160,
    gold: 50,
    items: [['character:leather_jerkin', 1]],
  },
  {
    id: 'feathers',
    title: 'Feathers for the Brew',
    giver: 'alchemist',
    requires: ['welcome'],
    offer: 'My healing draught needs a quill-oil that only comes from feathers. Bring me five ragged feathers and I will make it worth your while.',
    done: 'Perfect, perfect. Two draughts, fresh from the copper. Do not drink them both at once.',
    goal: { kind: 'bring', item: 'bestiary:feather', count: 5, label: 'Ragged Feathers' },
    xp: 90,
    gold: 0,
    items: [['character:draught', 2]],
  },
  {
    id: 'pelts',
    title: 'Pelts for Winter',
    giver: 'trader',
    requires: ['welcome'],
    offer: 'Winter will be long. Bring me six wolf pelts and I will pay above market. Way above. Well — a bit above.',
    done: 'Lovely, lovely fur. Here is your coin, as promised.',
    goal: { kind: 'bring', item: 'bestiary:wolf_pelt', count: 6, label: 'Wolf Pelts' },
    xp: 140,
    gold: 90,
  },
  {
    id: 'hounds',
    title: 'The Rabid Pack',
    giver: 'captain',
    requires: ['wolves'],
    minLevel: 3,
    offer: 'Something has driven the hounds mad. They froth and bite at anything that moves. Put down five of them — farther out, past where the wolves run.',
    done: 'Grim work, well done. The watch owes you a drink. And this purse.',
    goal: { kind: 'slay', species: 'hound', count: 5, label: 'Slay Rabid Hounds' },
    xp: 320,
    gold: 120,
  },
  {
    id: 'stones',
    title: 'Beyond the Stones',
    giver: 'elder',
    requires: ['wolves'],
    minLevel: 4,
    offer: 'The four stones at the crossroads open onto other lands. Step through the one marked for the Cinder Waste, look around, and come back to tell me what you saw.',
    done: 'Ash and embers... so the old songs were true. Thank you. Be careful out there.',
    goal: { kind: 'visit', world: 'fire', label: 'Visit the Cinder Waste' },
    xp: 220,
    gold: 40,
  },
  {
    id: 'alpha',
    title: 'The Alpha',
    giver: 'elder',
    requires: ['hounds'],
    minLevel: 5,
    offer: 'There is a great grey wolf the hunters call the Alpha. The packs follow it. End it, and the wild will remember its place for a while.',
    done: 'You have done what no one in this village could. Wear this charm with pride.',
    goal: { kind: 'slay', species: 'alpha', count: 1, label: 'Slay the Alpha Wolf' },
    xp: 600,
    gold: 200,
    items: [['character:wolf_tooth_charm', 1]],
  },
  {
    id: 'embers',
    title: 'Fangs of Fire',
    giver: 'alchemist',
    requires: ['stones'],
    offer: 'The hounds of the Cinder Waste carry fangs that never cool. Four of them and I can brew something truly potent.',
    done: 'Hot! Hot! Wonderful. Here — my strongest work.',
    goal: { kind: 'bring', item: 'bestiary:ember_fang', count: 4, label: 'Ember Fangs' },
    xp: 700,
    gold: 60,
    items: [['character:greater_draught', 2]],
  },
  {
    id: 'frost',
    title: 'Cold Hunt',
    giver: 'captain',
    requires: ['stones'],
    minLevel: 6,
    offer: 'Through the white stone there are wolves with ice in their blood. Six of them. Dress warm.',
    done: 'You came back with all your fingers. Impressive. Take this — you have earned it.',
    goal: { kind: 'slay', species: 'frost_wolf', count: 6, label: 'Slay Frost Wolves' },
    xp: 800,
    gold: 260,
  },
];

const VILLAGER_LINES = [
  'Lovely weather. Too lovely. Makes me nervous.',
  'They say the white stone leads somewhere cold enough to freeze your thoughts.',
  'Odo will buy anything with fur on it. Don’t ask what he does with it.',
  'Morwen’s draughts taste like boiled boots, but they work.',
  'The captain’s been looking for someone handy with a blade.',
  'Stay on the roads after dark. Things move in the trees.',
  'I heard the Alpha Wolf took a whole cart, horse and all.',
  'Have you tried the inn? The stew is mostly turnip.',
  'My cousin went through the green stone. Came back covered in moss. Wouldn’t talk about it.',
  'Eat something before you go out there. Travel bread keeps for weeks.',
];

export interface QuestEntry {
  id: string;
  title: string;
  progress: number;
  goal: number;
  objective: string;
  turnIn: string;
}

export interface QuestLog {
  active: QuestEntry[];
  done: string[];
}

interface DialogOption {
  label: string;
  intent?: { kind: string; [key: string]: unknown };
  note?: string;
  disabled?: boolean;
}

const TALK_RANGE = 2;
const SELL_RATE = 0.4;
const floor = (n: number): number => n | 0;
const abs = (n: number): number => (n < 0 ? -n : n);
const cheb = (a: { x: number; y: number }, b: { x: number; y: number }): number => {
  const dx = abs(a.x - b.x);
  const dy = abs(a.y - b.y);
  return dx > dy ? dx : dy;
};

function isInventory(value: unknown): value is InventoryComponent {
  if (typeof value !== 'object' || value === null) return false;
  const inv = value as Record<string, unknown>;
  return Array.isArray(inv.slots) && typeof inv.capacity === 'number';
}

function questLog(e: EntityState | undefined): QuestLog {
  const q = e?.components.quests as Partial<QuestLog> | undefined;
  return {
    active: Array.isArray(q?.active) ? q.active.map((a) => ({ ...a })) : [],
    done: Array.isArray(q?.done) ? [...q.done] : [],
  };
}

function residentOf(e: EntityState | undefined): Resident | undefined {
  const id = (e?.components.resident as { id?: string } | undefined)?.id;
  return RESIDENTS.find((r) => r.id === id);
}

function levelOf(e: EntityState): number {
  const s = e.components.stats as { level?: number } | undefined;
  return typeof s?.level === 'number' ? s.level : 1;
}

function count(e: EntityState | undefined, itemId: string): number {
  const inv = e?.components.inventory;
  if (!isInventory(inv)) return 0;
  return inv.slots.reduce((n, s) => (s.itemId === itemId ? n + s.count : n), 0);
}

/** Take items out of the (core-owned) inventory; false if there are not enough. */
function take(world: WorldAPI, id: number, itemId: string, n: number): boolean {
  const e = world.get(id);
  const inv = e?.components.inventory;
  if (!isInventory(inv) || count(e, itemId) < n) return false;
  let left = n;
  const slots = inv.slots.map((s) => ({ ...s }));
  for (let i = slots.length - 1; i >= 0 && left > 0; i--) {
    if (slots[i].itemId !== itemId) continue;
    const used = slots[i].count < left ? slots[i].count : left;
    slots[i].count -= used;
    left -= used;
    if (slots[i].count <= 0) slots[i] = { itemId: '', count: 0 };
  }
  world.update(id, { inventory: { ...inv, slots } });
  return true;
}

function allItems(world: WorldAPI): ItemDef[] {
  const seen = new Map<string, ItemDef>();
  for (const tag of ['merchandise', 'loot', 'consumable', 'equipment', 'material', 'herb', 'stone', 'seed']) {
    for (const def of world.queryItemsByTag(tag)) seen.set(def.id, def);
  }
  return [...seen.values()];
}

function itemDef(world: WorldAPI, id: string): ItemDef | undefined {
  return allItems(world).find((d) => d.id === id);
}

function entryFor(def: QuestDef, progress: number): QuestEntry {
  const g = def.goal;
  const goal = g.kind === 'slay' || g.kind === 'bring' ? g.count : 1;
  const turnIn = RESIDENTS.find((r) => r.id === (def.turnIn ?? def.giver))?.name ?? '';
  return { id: def.id, title: def.title, progress, goal, objective: g.label, turnIn };
}

function setDialog(
  world: WorldAPI,
  playerId: number,
  npc: EntityState,
  name: string,
  text: string,
  options: DialogOption[],
): void {
  world.update(playerId, {
    dialog: { npcId: npc.id, name, text, options, closeIntent: 'town:close' },
  });
}

function choose(npcId: number, action: string, extra: Record<string, unknown> = {}): DialogOption['intent'] {
  return { kind: 'town:choose', npcId, action, ...extra };
}

/** The opening page of a conversation with a resident. */
function rootPage(world: WorldAPI, player: EntityState, npc: EntityState, resident: Resident, text?: string): void {
  const log = questLog(player);
  const options: DialogOption[] = [];

  for (const entry of log.active) {
    const def = QUESTS.find((q) => q.id === entry.id);
    if (!def || (def.turnIn ?? def.giver) !== resident.id) continue;
    const ready = isComplete(player, def, entry);
    options.push({
      label: ready ? `✔ ${def.title}` : `… ${def.title}`,
      intent: choose(npc.id, ready ? 'complete' : 'status', { quest: def.id }),
      note: ready ? 'Complete' : `${progressOf(player, def, entry)}/${entry.goal}`,
    });
  }
  for (const def of QUESTS) {
    if (def.giver !== resident.id) continue;
    if (log.done.includes(def.id) || log.active.some((a) => a.id === def.id)) continue;
    if (!def.requires.every((r) => log.done.includes(r))) continue;
    const tooLow = def.minLevel !== undefined && levelOf(player) < def.minLevel;
    options.push({
      label: `! ${def.title}`,
      intent: tooLow ? undefined : choose(npc.id, 'offer', { quest: def.id }),
      note: tooLow ? `Level ${def.minLevel}` : 'New quest',
      disabled: tooLow,
    });
  }
  if (resident.shop) {
    options.push({ label: 'Show me your wares.', intent: choose(npc.id, 'buy') });
    options.push({ label: 'I have things to sell.', intent: choose(npc.id, 'sell') });
  }
  options.push({ label: 'Any news?', intent: choose(npc.id, 'rumor') });
  options.push({ label: 'Farewell.', intent: { kind: 'town:close' } });
  const greeting = resident.greeting[floor(world.rng() * resident.greeting.length)];
  setDialog(world, player.id, npc, resident.name, text ?? greeting, options);
}

function progressOf(player: EntityState, def: QuestDef, entry: QuestEntry): number {
  if (def.goal.kind === 'bring') {
    const have = count(player, def.goal.item);
    return have > def.goal.count ? def.goal.count : have;
  }
  return entry.progress;
}

function isComplete(player: EntityState, def: QuestDef, entry: QuestEntry): boolean {
  return progressOf(player, def, entry) >= entry.goal;
}

function rewardText(world: WorldAPI, def: QuestDef): string {
  const parts = [`${def.xp} XP`];
  if (def.gold > 0) parts.push(`${def.gold} gold`);
  for (const [id, n] of def.items ?? []) parts.push(`${n > 1 ? `${n}× ` : ''}${itemDef(world, id)?.name ?? id}`);
  return parts.join(', ');
}

/** Connection token per player entity, from 'town:claim'; quests are saved under it. */
const tokens = new Map<number, string>();

function writeQuests(world: WorldAPI, id: number, log: QuestLog): void {
  world.update(id, { quests: log });
  const token = tokens.get(id);
  if (token) world.getSet(`town:save:${token}`, JSON.stringify(log));
}

function claim(world: WorldAPI, id: number, args: unknown): void {
  const token = (args as { token?: unknown } | undefined)?.token;
  if (typeof token !== 'string' || !/^[a-z0-9]{16,64}$/.test(token)) return;
  tokens.set(id, token);
  const raw = world.getSet(`town:save:${token}`);
  if (!raw) return;
  try {
    const saved = JSON.parse(raw) as Partial<QuestLog>;
    const log: QuestLog = {
      active: (Array.isArray(saved.active) ? saved.active : []).filter((a) => QUESTS.some((q) => q.id === a.id)),
      done: (Array.isArray(saved.done) ? saved.done : []).filter((d) => typeof d === 'string'),
    };
    world.update(id, { quests: log });
  } catch {
    // A corrupt record just means starting the quest log over.
  }
}

function accept(world: WorldAPI, player: EntityState, npc: EntityState, resident: Resident, questId: unknown): void {
  const def = QUESTS.find((q) => q.id === questId && q.giver === resident.id);
  if (!def) return;
  const log = questLog(player);
  if (log.done.includes(def.id) || log.active.some((a) => a.id === def.id)) return;
  if (!def.requires.every((r) => log.done.includes(r))) return;
  if (def.minLevel !== undefined && levelOf(player) < def.minLevel) return;
  log.active.push(entryFor(def, 0));
  writeQuests(world, player.id, log);
  world.emit('character:grant', { entityId: player.id, reason: `Quest accepted: ${def.title}`, tone: 'quest' });
  if (def.goal.kind === 'talk' && def.items) {
    for (const [itemId, n] of def.items) world.give(player.id, itemId, n);
  }
  rootPage(world, world.get(player.id) ?? player, npc, resident, `${def.title}: ${def.goal.label}. Return to ${entryFor(def, 0).turnIn} when it is done.`);
}

function complete(world: WorldAPI, player: EntityState, npc: EntityState, resident: Resident, questId: unknown): void {
  const def = QUESTS.find((q) => q.id === questId && (q.turnIn ?? q.giver) === resident.id);
  if (!def) return;
  const log = questLog(player);
  const entry = log.active.find((a) => a.id === def.id);
  if (!entry || !isComplete(player, def, entry)) return;
  if (def.goal.kind === 'bring' && !take(world, player.id, def.goal.item, def.goal.count)) return;
  log.active = log.active.filter((a) => a.id !== def.id);
  log.done.push(def.id);
  writeQuests(world, player.id, log);
  if (def.goal.kind !== 'talk') {
    for (const [itemId, n] of def.items ?? []) {
      const left = world.give(player.id, itemId, n);
      if (left > 0) world.spawn('item', { x: player.x, y: player.y }, { itemDrop: { itemId, count: left } }, player.world);
    }
  }
  world.emit('character:grant', {
    entityId: player.id,
    xp: def.xp,
    gold: def.gold,
    reason: `Quest complete: ${def.title} · ${rewardText(world, def)}`,
    tone: 'quest',
  });
  world.emit('town:quest-complete', { entityId: player.id, quest: def.id });
  rootPage(world, world.get(player.id) ?? player, npc, resident, def.done);
}

function shopStock(world: WorldAPI, resident: Resident): ItemDef[] {
  const wanted = resident.shop === 'gear' ? ['weapon', 'armor', 'charm'] : ['potion', 'food'];
  return world
    .queryItemsByTag('merchandise')
    .filter((d) => d.value !== undefined && d.tags.some((t) => wanted.includes(t)))
    .sort((a, b) => (a.value ?? 0) - (b.value ?? 0));
}

function buyPage(world: WorldAPI, player: EntityState, npc: EntityState, resident: Resident, text?: string): void {
  const gold = (player.components.character as { gold?: number } | undefined)?.gold ?? 0;
  const options: DialogOption[] = shopStock(world, resident).map((d) => ({
    label: `${d.icon ? `${d.icon} ` : ''}${d.name}`,
    intent: choose(npc.id, 'purchase', { item: d.id }),
    note: `${d.value}g`,
    disabled: (d.value ?? 0) > gold,
  }));
  options.push({ label: 'Back.', intent: choose(npc.id, 'root') });
  setDialog(world, player.id, npc, resident.name, text ?? `Take a look. You have ${gold} gold.`, options);
}

function sellable(world: WorldAPI, player: EntityState): { def: ItemDef; count: number; price: number }[] {
  const inv = player.components.inventory;
  if (!isInventory(inv)) return [];
  const totals = new Map<string, number>();
  for (const s of inv.slots) if (s.count > 0) totals.set(s.itemId, (totals.get(s.itemId) ?? 0) + s.count);
  const out: { def: ItemDef; count: number; price: number }[] = [];
  for (const [id, n] of totals) {
    const def = itemDef(world, id);
    if (!def?.value) continue;
    const price = floor(def.value * SELL_RATE) || 1;
    out.push({ def, count: n, price });
  }
  return out.sort((a, b) => b.price * b.count - a.price * a.count);
}

function sellPage(world: WorldAPI, player: EntityState, npc: EntityState, resident: Resident, text?: string): void {
  const goods = sellable(world, player);
  const loot = goods.filter((g) => g.def.tags.includes('loot'));
  const lootTotal = loot.reduce((n, g) => n + g.price * g.count, 0);
  const options: DialogOption[] = [];
  if (loot.length > 0) {
    options.push({
      label: `Sell all trophies (${loot.reduce((n, g) => n + g.count, 0)} items)`,
      intent: choose(npc.id, 'sell-loot'),
      note: `+${lootTotal}g`,
    });
  }
  for (const g of goods.slice(0, 7)) {
    options.push({
      label: `${g.def.icon ? `${g.def.icon} ` : ''}${g.def.name}${g.count > 1 ? ` ×${g.count}` : ''}`,
      intent: choose(npc.id, 'sell-one', { item: g.def.id }),
      note: `+${g.price}g`,
    });
  }
  options.push({ label: 'Back.', intent: choose(npc.id, 'root') });
  const say = goods.length === 0 ? 'You have nothing I want. Come back with pelts.' : 'Let us see what you have.';
  setDialog(world, player.id, npc, resident.name, text ?? say, options);
}

function purchase(world: WorldAPI, player: EntityState, npc: EntityState, resident: Resident, itemId: unknown): void {
  const def = shopStock(world, resident).find((d) => d.id === itemId);
  if (!def || def.value === undefined) return;
  world.emit('character:charge', {
    entityId: player.id,
    gold: def.value,
    then: (w: WorldAPI, ok: boolean) => {
      const fresh = w.get(player.id) ?? player;
      if (!ok) {
        buyPage(w, fresh, npc, resident, 'You cannot afford that, friend.');
        return;
      }
      const left = w.give(player.id, def.id, 1);
      if (left > 0) {
        w.emit('character:grant', { entityId: player.id, gold: def.value, reason: 'Your pack is full — refunded.' });
        buyPage(w, fresh, npc, resident, 'Your pack is full. Make some room first.');
        return;
      }
      w.emit('character:grant', { entityId: player.id, reason: `Bought ${def.name} for ${def.value} gold.` });
      buyPage(w, w.get(player.id) ?? fresh, npc, resident, `A fine choice. ${def.name}, yours.`);
    },
  });
}

function sellItems(world: WorldAPI, player: EntityState, npc: EntityState, resident: Resident, which: 'loot' | string): void {
  const goods = sellable(world, player).filter((g) => (which === 'loot' ? g.def.tags.includes('loot') : g.def.id === which));
  let total = 0;
  let sold = 0;
  for (const g of goods) {
    const n = which === 'loot' ? g.count : 1;
    if (!take(world, player.id, g.def.id, n)) continue;
    total += g.price * n;
    sold += n;
  }
  if (sold === 0) return;
  world.emit('character:grant', { entityId: player.id, gold: total, reason: `Sold ${sold} item${sold > 1 ? 's' : ''} for ${total} gold.`, tone: 'loot' });
  sellPage(world, world.get(player.id) ?? player, npc, resident, `Pleasure doing business. ${total} gold.`);
}

function onTalk(world: WorldAPI, playerId: number, args: unknown): void {
  const player = world.get(playerId);
  const targetId = (args as { targetId?: unknown } | undefined)?.targetId;
  if (!player) return;
  const candidates = world
    .queryNear(player.x, player.y, TALK_RANGE, player.world)
    .filter((e) => e.components.resident !== undefined);
  const npc = candidates.find((e) => e.id === targetId) ?? candidates[0];
  const resident = residentOf(npc);
  if (!npc || !resident) return;

  const log = questLog(player);
  const talk = log.active.find((a) => {
    const def = QUESTS.find((q) => q.id === a.id);
    return def?.goal.kind === 'talk' && def.goal.npc === resident.id;
  });
  if (talk) {
    talk.progress = 1;
    writeQuests(world, player.id, log);
  }
  rootPage(world, world.get(player.id) ?? player, npc, resident);
}

function onChat(world: WorldAPI, playerId: number, args: unknown): void {
  const player = world.get(playerId);
  const targetId = (args as { targetId?: unknown } | undefined)?.targetId;
  if (!player || typeof targetId !== 'number') return;
  const npc = world.get(targetId);
  if (!npc || npc.kind !== 'npc' || cheb(npc, player) > TALK_RANGE) return;
  const line = VILLAGER_LINES[floor(world.rng() * VILLAGER_LINES.length)];
  setDialog(world, player.id, npc, 'Villager', line, [{ label: 'Farewell.', intent: { kind: 'town:close' } }]);
}

function onChoose(world: WorldAPI, playerId: number, args: unknown): void {
  const a = (args ?? {}) as { npcId?: unknown; action?: unknown; quest?: unknown; item?: unknown };
  const player = world.get(playerId);
  if (!player || typeof a.npcId !== 'number') return;
  const npc = world.get(a.npcId);
  const resident = residentOf(npc);
  if (!npc || !resident || cheb(npc, player) > TALK_RANGE + 1) return;
  switch (a.action) {
    case 'root':
      return rootPage(world, player, npc, resident);
    case 'offer': {
      const def = QUESTS.find((q) => q.id === a.quest && q.giver === resident.id);
      if (!def) return;
      return setDialog(world, player.id, npc, resident.name, `${def.offer}\n\nReward: ${rewardText(world, def)}`, [
        { label: 'I will do it.', intent: choose(npc.id, 'accept', { quest: def.id }) },
        { label: 'Not now.', intent: choose(npc.id, 'root') },
      ]);
    }
    case 'accept':
      return accept(world, player, npc, resident, a.quest);
    case 'complete':
      return complete(world, player, npc, resident, a.quest);
    case 'status': {
      const def = QUESTS.find((q) => q.id === a.quest);
      const entry = questLog(player).active.find((e) => e.id === a.quest);
      if (!def || !entry) return rootPage(world, player, npc, resident);
      return rootPage(world, player, npc, resident, `${def.goal.label}: ${progressOf(player, def, entry)} of ${entry.goal}. Come back when it is done.`);
    }
    case 'buy':
      if (resident.shop) buyPage(world, player, npc, resident);
      return;
    case 'sell':
      if (resident.shop) sellPage(world, player, npc, resident);
      return;
    case 'purchase':
      if (resident.shop) purchase(world, player, npc, resident, a.item);
      return;
    case 'sell-loot':
      if (resident.shop) sellItems(world, player, npc, resident, 'loot');
      return;
    case 'sell-one':
      if (resident.shop && typeof a.item === 'string') sellItems(world, player, npc, resident, a.item);
      return;
    case 'rumor':
      return rootPage(world, player, npc, resident, VILLAGER_LINES[floor(world.rng() * VILLAGER_LINES.length)]);
  }
}

function findSpot(world: WorldAPI, x: number, y: number): { x: number; y: number } {
  for (let r = 0; r < 4; r++) {
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        if (world.walkable(x + dx, y + dy, OVERWORLD) && world.queryNear(x + dx, y + dy, 0, OVERWORLD).length === 0) {
          return { x: x + dx, y: y + dy };
        }
      }
    }
  }
  return { x, y };
}

function settle(world: WorldAPI): void {
  for (const r of RESIDENTS) {
    const at = findSpot(world, WORLD_CENTER_X + r.dx, WORLD_CENTER_Y + r.dy);
    world.spawn(
      'town:resident',
      at,
      {
        resident: { id: r.id },
        name: r.name,
        label: r.name,
        dialogue: true,
        interact: { intent: 'town:talk', label: 'Talk to', range: 1 },
        appearance: { character: r.character, scale: 1.5 },
      },
      OVERWORLD,
    );
  }
  world.log(`${RESIDENTS.length} residents settled in the village`);
}

let clock = 0;

export default definePlugin({
  id: 'town',
  items: [],
  recipes: [],
  entityKinds: ['town:resident'],

  systems: [
    {
      name: 'town:tick',
      fn: (world) => {
        clock++;
        if (clock === 30 || clock % 600 === 0) {
          if (world.getSet('town:residents-v1') === undefined && world.tile(WORLD_CENTER_X, WORLD_CENTER_Y, OVERWORLD) === 'dirt') {
            world.getSet('town:residents-v1', '1');
            settle(world);
          }
        }
        if (clock % 600 === 0) for (const id of tokens.keys()) if (!world.get(id)) tokens.delete(id);
        if (clock % 5 !== 0) return;
        for (const p of world.query('player', 'dialog')) {
          const d = p.components.dialog as { npcId?: number } | null;
          if (!d) continue;
          const npc = typeof d.npcId === 'number' ? world.get(d.npcId) : undefined;
          if (!npc || (npc.world ?? OVERWORLD) !== (p.world ?? OVERWORLD) || cheb(npc, p) > TALK_RANGE + 1) {
            world.update(p.id, { dialog: null });
          }
        }
        for (const p of world.query('player', 'quests')) {
          const log = questLog(p);
          let changed = false;
          for (const entry of log.active) {
            const def = QUESTS.find((q) => q.id === entry.id);
            if (def?.goal.kind === 'visit' && entry.progress < 1 && (p.world ?? OVERWORLD) === def.goal.world) {
              entry.progress = 1;
              changed = true;
              world.emit('character:grant', { entityId: p.id, reason: `${def.title}: objective complete. Return to ${entry.turnIn}.`, tone: 'quest' });
            }
          }
          if (changed) writeQuests(world, p.id, log);
        }
      },
    },
  ],

  commands: [
    { name: 'town:talk', fn: (world, args, id) => onTalk(world, id, args) },
    { name: 'town:chat', fn: (world, args, id) => onChat(world, id, args) },
    { name: 'town:choose', fn: (world, args, id) => onChoose(world, id, args) },
    { name: 'town:close', fn: (world, _args, id) => void world.update(id, { dialog: null }) },
    { name: 'town:claim', fn: (world, args, id) => claim(world, id, args) },
  ],

  events: {
    'bestiary:slain': (world, payload) => {
      const p = payload as { killerId?: unknown; species?: unknown };
      if (typeof p.killerId !== 'number' || typeof p.species !== 'string') return;
      const player = world.get(p.killerId);
      if (!player) return;
      const log = questLog(player);
      let changed = false;
      for (const entry of log.active) {
        const def = QUESTS.find((q) => q.id === entry.id);
        if (def?.goal.kind !== 'slay' || def.goal.species !== p.species || entry.progress >= entry.goal) continue;
        entry.progress += 1;
        changed = true;
        if (entry.progress >= entry.goal) {
          world.emit('character:grant', { entityId: player.id, reason: `${def.title}: objective complete. Return to ${entry.turnIn}.`, tone: 'quest' });
        }
      }
      if (changed) writeQuests(world, player.id, log);
    },
  },
});
