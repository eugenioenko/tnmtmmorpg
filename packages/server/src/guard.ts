export interface GuardOptions {
  /** A system running longer than this many ms counts as a strike. */
  budgetMs?: number;
  /** Consecutive failures before a system is auto-disabled. */
  maxStrikes?: number;
  /** Called the moment a system is auto-disabled. */
  onDisabled?: (feature: string, name: string, reason: string) => void;
}

interface GuardState {
  strikes: number;
  disabled: boolean;
}

/**
 * Error isolation for feature code. Every system, command and event handler
 * runs through `run()`: an exception or a time-budget overrun counts as a
 * strike, and three consecutive strikes auto-disable that system for the
 * rest of the process. The tick loop keeps running — disabled systems are
 * simply skipped, and everything else is unaffected.
 *
 * The time budget is measured after the call returns, so a literally
 * infinite loop cannot be preempted synchronously (that needs a worker
 * process). Any finite but too-slow system is caught and disabled.
 */
export function createGuard(options: GuardOptions = {}) {
  const budgetMs = options.budgetMs ?? 5;
  const maxStrikes = options.maxStrikes ?? 3;
  const states = new Map<string, GuardState>();

  function isDisabled(name: string): boolean {
    return states.get(name)?.disabled ?? false;
  }

  /** Names of every auto-disabled system; surfaced in snapshots for the client banner. */
  function disabledSystems(): string[] {
    const out: string[] = [];
    for (const [name, state] of states) {
      if (state.disabled) out.push(name);
    }
    return out;
  }

  function strike(name: string, feature: string, reason: string): void {
    const state = states.get(name) ?? { strikes: 0, disabled: false };
    state.strikes++;
    states.set(name, state);
    if (state.strikes >= maxStrikes && !state.disabled) {
      state.disabled = true;
      options.onDisabled?.(feature, name, reason);
      console.error(
        [
          `[guard] ============== FEATURE SYSTEM DISABLED ==============`,
          `[guard] ${name} (feature '${feature}') is now disabled.`,
          `[guard] reason: ${reason}`,
          `[guard] it will not run again until the server restarts.`,
          `[guard] every other feature keeps running; the tick is unaffected.`,
          `[guard] =====================================================`,
        ].join('\n'),
      );
    }
  }

  return {
    isDisabled,
    disabledSystems,

    /**
     * Run feature code under the guard. Returns true when the call ran to
     * completion within budget; false when it threw, overran, or was skipped
     * because the system is already disabled.
     */
    run(feature: string, name: string, fn: () => void): boolean {
      if (isDisabled(name)) return false;

      const start = performance.now();
      try {
        fn();
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`[guard] feature '${feature}' system '${name}' threw: ${message}`);
        strike(name, feature, `threw: ${message}`);
        return false;
      }

      const elapsedMs = performance.now() - start;
      if (elapsedMs > budgetMs) {
        console.error(
          `[guard] feature '${feature}' system '${name}' exceeded time budget: ` +
            `${elapsedMs.toFixed(1)}ms > ${budgetMs}ms`,
        );
        strike(name, feature, `time budget exceeded (${elapsedMs.toFixed(1)}ms > ${budgetMs}ms)`);
        return false;
      }

      const state = states.get(name);
      if (state) state.strikes = 0; // success resets the consecutive-failure count
      return true;
    },
  };
}

export type SystemGuard = ReturnType<typeof createGuard>;
