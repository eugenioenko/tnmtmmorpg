/**
 * The shared type barrel: every type, constant and runtime guard that core
 * and features share. Features import from '@game/shared' only.
 */
export * from './types/entities.ts';
export * from './types/intents.ts';
export * from './types/components.ts';
export * from './types/items.ts';
export * from './types/messages.ts';
export * from './types/plugin.ts';
export * from './terrain.ts';
export * from './guards.ts';

// ── Binary wire protocol ───────────────────────────────────────────────────
// The compact encoder/decoder for ServerMessages (binary.ts). Re-exported
// here so both the server and the client can `import { encodeServerMessage,
// decodeServerMessage } from '@game/shared'`. The circular import is safe:
// binary.ts only references this module's exports at call time.
export * from './binary.ts';
