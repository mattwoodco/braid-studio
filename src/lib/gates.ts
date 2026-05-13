export type Gate = "G1" | "G2" | "G3" | "G4" | "G5" | "G6";

export type GateConfig = {
  threshold: number;
  budgetUsd: number;
  requiresHITL?: boolean;
};

export const GATES: Record<Gate, GateConfig> = {
  G1: { threshold: 0.72, budgetUsd: 0.5 },
  G2: { threshold: 0.85, budgetUsd: 0.7 },
  G3: { threshold: 0.74, budgetUsd: 2.0 },
  G4: { threshold: 0.74, budgetUsd: 5.0, requiresHITL: true },
  G5: { threshold: 0.72, budgetUsd: 15.0 },
  G6: { threshold: 0.0, budgetUsd: 25.0, requiresHITL: true },
};

export type GateInput = {
  gate: Gate;
  meanScore: number;
  cumulativeSpendUsd: number;
  hitlApproved?: boolean;
};

export type GateResult = {
  passed: boolean;
  reason: "score_below_threshold" | "budget_exceeded" | "hitl_required" | "ok";
};

export function passGate(input: GateInput): GateResult {
  const cfg = GATES[input.gate];
  if (input.cumulativeSpendUsd >= cfg.budgetUsd) {
    return { passed: false, reason: "budget_exceeded" };
  }
  if (cfg.requiresHITL && !input.hitlApproved) {
    return { passed: false, reason: "hitl_required" };
  }
  if (input.meanScore < cfg.threshold) {
    return { passed: false, reason: "score_below_threshold" };
  }
  return { passed: true, reason: "ok" };
}
