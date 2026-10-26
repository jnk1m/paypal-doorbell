// The gate every live model call passes (R13): the hourly limit for live model calls, then the day's money budget. If either says
// no, no call is made and the cause is "not diagnosed" (rate_limited / budget); gap finding is not affected.
// diagnose() refuses to make a live call without one (cause.ts), so there is no unguarded path to the model.
import { createBudget } from "../budget.ts";
import { costUsd } from "../core/llm.ts";
import type { createLimiter } from "../limits.ts";
import type { CallOutcome, LiveGate } from "./cause.ts";

// What the budget does with each outcome of a call: billed -> the reservation becomes the real cost; not billed (an HTTP error response,
// a missing key) -> the whole reservation is given back, so failures that cost nothing cannot lock the day; unknown (timeout, abort) -> it stays.
export async function settleOutcome(reservation: { settle(usd: number): Promise<void>; release(): Promise<void> }, outcome: CallOutcome): Promise<void> {
  if (outcome.billed === "yes") await reservation.settle(costUsd(outcome.usage));
  else if (outcome.billed === "no") await reservation.release();
}

export function createLiveGate(deps: { limiter: ReturnType<typeof createLimiter>; budget: ReturnType<typeof createBudget>; ip: string; session?: string }): LiveGate {
  return {
    async acquire({ worstCaseUsd }) {
      const limit = await deps.limiter.checkLimit("model", { ip: deps.ip, session: deps.session });
      if (!limit.ok) return { ok: false, reason: "rate_limited" };
      const reservation = await deps.budget.reserve(worstCaseUsd);
      if (!reservation) return { ok: false, reason: "budget" };
      return { ok: true, settle: (outcome) => settleOutcome(reservation, outcome) };
    },
  };
}

// For the evaluation harness and the recorder script, which are not behind a public limit but must still never spend past a cap they were given.
export function spendCapGate(maxUsd: number) {
  const budget = createBudget({ redis: null, dailyUsd: maxUsd });
  const gate: LiveGate = {
    async acquire({ worstCaseUsd }) {
      const reservation = await budget.reserve(worstCaseUsd);
      return reservation ? { ok: true, settle: (outcome) => settleOutcome(reservation, outcome) } : { ok: false, reason: "budget" };
    },
  };
  return Object.assign(gate, { spentUsd: () => budget.spentUsd() });
}
