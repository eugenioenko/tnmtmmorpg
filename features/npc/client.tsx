import { defineClient } from '@game/shared';

/**
 * Client half of the npc feature: the glyph for the 'npc' entity kind.
 * Registered via the client's import.meta.glob at boot — no core client file
 * changes. Health bars and click-to-attack are core renderer concerns and
 * work off the `stats` component, so there is nothing else to do here.
 *
 * With this feature uninstalled, persisted NPCs still render — the atlas
 * falls back to its placeholder box for unknown kinds.
 */
export default defineClient({
  sprites: {
    npc: '🤖',
  },
});
