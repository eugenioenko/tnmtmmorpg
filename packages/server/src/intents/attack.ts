import type { AttackIntent } from '@game/shared';
import { handleAttack, type CombatContext } from '../systems/combat.ts';
import { isInteger } from './util.ts';

/** The intent context the 'attack' handler needs: world + event bus. */
export interface AttackIntentContext {
  /** Phase 7: world + event bus for the 'attack' intent (adjacency + damage). */
  combat?: CombatContext;
}

/**
 * Apply an 'attack' intent: hit `targetId` if adjacent. The target id is
 * client-supplied but harmless: handleAttack gates on adjacency and stats,
 * so a forged id hits nothing it shouldn't.
 */
export function handleAttackIntent(
  ctx: AttackIntentContext,
  entityId: number,
  intent: AttackIntent,
): void {
  if (!ctx.combat) {
    console.warn(`[tick] entity ${entityId} attack: no combat system — rejected`);
    return;
  }
  const targetId = intent.targetId;
  if (!isInteger(targetId)) {
    console.warn(`[tick] entity ${entityId} attack: targetId must be an integer — rejected`);
    return;
  }
  handleAttack(ctx.combat, entityId, targetId);
}
