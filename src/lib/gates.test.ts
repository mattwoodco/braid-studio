import { describe, expect, test } from "bun:test";
import { GATES, type Gate, passGate } from "./gates";

describe("GATES config", () => {
  test("G1 threshold + budget", () => {
    expect(GATES.G1.threshold).toBe(0.72);
    expect(GATES.G1.budgetUsd).toBe(0.5);
    expect(GATES.G1.requiresHITL).toBeUndefined();
  });
  test("G2 threshold + budget", () => {
    expect(GATES.G2.threshold).toBe(0.85);
    expect(GATES.G2.budgetUsd).toBe(0.7);
  });
  test("G3 threshold + budget", () => {
    expect(GATES.G3.threshold).toBe(0.74);
    expect(GATES.G3.budgetUsd).toBe(2.0);
  });
  test("G4 requires HITL", () => {
    expect(GATES.G4.threshold).toBe(0.74);
    expect(GATES.G4.budgetUsd).toBe(5.0);
    expect(GATES.G4.requiresHITL).toBe(true);
  });
  test("G5 threshold + budget", () => {
    expect(GATES.G5.threshold).toBe(0.72);
    expect(GATES.G5.budgetUsd).toBe(15.0);
  });
  test("G6 requires HITL with zero threshold", () => {
    expect(GATES.G6.threshold).toBe(0.0);
    expect(GATES.G6.budgetUsd).toBe(25.0);
    expect(GATES.G6.requiresHITL).toBe(true);
  });
});

describe("passGate", () => {
  test("ok happy path", () => {
    const r = passGate({ gate: "G1", meanScore: 0.8, cumulativeSpendUsd: 0.1 });
    expect(r).toEqual({ passed: true, reason: "ok" });
  });

  test("budget exceeded checked first", () => {
    const r = passGate({ gate: "G1", meanScore: 0.99, cumulativeSpendUsd: 0.5 });
    expect(r).toEqual({ passed: false, reason: "budget_exceeded" });
  });

  test("budget exceeded over", () => {
    const r = passGate({ gate: "G2", meanScore: 0.9, cumulativeSpendUsd: 0.71 });
    expect(r.passed).toBe(false);
    expect(r.reason).toBe("budget_exceeded");
  });

  test("HITL required when not approved", () => {
    const r = passGate({ gate: "G4", meanScore: 0.9, cumulativeSpendUsd: 1 });
    expect(r).toEqual({ passed: false, reason: "hitl_required" });
  });

  test("HITL approved passes if score meets threshold", () => {
    const r = passGate({
      gate: "G4",
      meanScore: 0.8,
      cumulativeSpendUsd: 1,
      hitlApproved: true,
    });
    expect(r).toEqual({ passed: true, reason: "ok" });
  });

  test("score below threshold", () => {
    const r = passGate({ gate: "G2", meanScore: 0.84, cumulativeSpendUsd: 0.1 });
    expect(r).toEqual({ passed: false, reason: "score_below_threshold" });
  });

  test("score exactly threshold ok", () => {
    const r = passGate({ gate: "G1", meanScore: 0.72, cumulativeSpendUsd: 0 });
    expect(r.passed).toBe(true);
  });

  test("G6 zero threshold with HITL approval", () => {
    const r = passGate({
      gate: "G6",
      meanScore: 0,
      cumulativeSpendUsd: 1,
      hitlApproved: true,
    });
    expect(r).toEqual({ passed: true, reason: "ok" });
  });

  test("G6 without HITL fails hitl_required", () => {
    const r = passGate({ gate: "G6", meanScore: 1, cumulativeSpendUsd: 1 });
    expect(r.reason).toBe("hitl_required");
  });

  test("each gate threshold boundary", () => {
    const gates: Gate[] = ["G1", "G2", "G3", "G5"];
    for (const g of gates) {
      const cfg = GATES[g];
      const below = passGate({
        gate: g,
        meanScore: cfg.threshold - 0.01,
        cumulativeSpendUsd: 0,
      });
      expect(below.passed).toBe(false);
      expect(below.reason).toBe("score_below_threshold");
      const at = passGate({
        gate: g,
        meanScore: cfg.threshold,
        cumulativeSpendUsd: 0,
      });
      expect(at.passed).toBe(true);
    }
  });

  test("each gate budget boundary", () => {
    const gates: Gate[] = ["G1", "G2", "G3", "G4", "G5", "G6"];
    for (const g of gates) {
      const cfg = GATES[g];
      const r = passGate({
        gate: g,
        meanScore: 1,
        cumulativeSpendUsd: cfg.budgetUsd,
        hitlApproved: true,
      });
      expect(r.passed).toBe(false);
      expect(r.reason).toBe("budget_exceeded");
    }
  });
});
