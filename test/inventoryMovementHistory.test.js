import { describe, it, expect } from "vitest";
import { computeLedger, mapMovementType, MOVEMENT_TYPE_MAP } from "../src/services/inventoryMovementHistory.js";

// The stock card anchors to on-hand and derives the opening, so it reconciles
// to current stock regardless of purged pre-window history (live: ICHIST starts
// 2016-03-01 but item 318 on-hand 7422 ≠ Σ history 3999).
describe("computeLedger — anchored reconciliation", () => {
  it("opening + movements = closing = on-hand (window covers up to today)", () => {
    const movements = [
      { stock_qty: 100, movement_type: "Purchase receipt" }, // in
      { stock_qty: -30, movement_type: "Sale" },             // out
      { stock_qty: 5, movement_type: "Credit / Return" },    // in
      { stock_qty: -2, movement_type: "Adjustment / Write-off" }, // out
    ];
    // closing == on-hand because `to` is open (nothing after the window).
    const r = computeLedger({ onHand: 200, closing: 200, movements });
    // window net = 100 - 30 + 5 - 2 = 73 → opening = 200 - 73 = 127
    expect(r.opening_balance).toBe(127);
    expect(r.window_net).toBe(73);
    expect(r.closing_balance).toBe(200);
    // running balance ends at on-hand
    expect(r.movements.at(-1).balance).toBe(200);
    expect(r.reconciles).toBe(true);
    expect(r.reconcile_variance).toBe(0);
  });

  it("running balance is correct step by step", () => {
    const movements = [
      { stock_qty: 100 }, // opening 127 → 227? no: opening = closing - net
      { stock_qty: -30 },
    ];
    const r = computeLedger({ onHand: 100, closing: 100, movements });
    // net = 70 → opening = 30; after +100 → 130; after -30 → 100
    expect(r.opening_balance).toBe(30);
    expect(r.movements[0].balance).toBe(130);
    expect(r.movements[1].balance).toBe(100);
  });

  it("reconciles to a PAST closing when movements happened after the window", () => {
    // to=past: closing(to) = on_hand - (movements after to). Caller passes that
    // closing; the ledger must end there, not at current on-hand.
    const movements = [{ stock_qty: 50 }, { stock_qty: -20 }]; // net 30
    const r = computeLedger({ onHand: 500, closing: 80, movements });
    expect(r.opening_balance).toBe(50); // 80 - 30
    expect(r.movements.at(-1).balance).toBe(80);
    expect(r.reconciles).toBe(true);
  });

  it("empty window: opening = closing, no movements", () => {
    const r = computeLedger({ onHand: 42, closing: 42, movements: [] });
    expect(r.opening_balance).toBe(42);
    expect(r.closing_balance).toBe(42);
    expect(r.movements).toHaveLength(0);
    expect(r.reconciles).toBe(true);
  });
});

describe("mapMovementType — Sage app/transtype → label", () => {
  it("maps the known live combinations", () => {
    expect(mapMovementType("OE", 4, -10)).toBe("Sale");
    expect(mapMovementType("OE", 17, 5)).toBe("Credit / Return");
    expect(mapMovementType("PO", 1, 100)).toBe("Purchase receipt");
    expect(mapMovementType("IC", 10, 3)).toBe("Adjustment (increase)");
    expect(mapMovementType("IC", 11, -3)).toBe("Adjustment / Write-off");
  });

  it("falls back by sign for unknown combinations (nothing dropped)", () => {
    expect(mapMovementType("XX", 99, 5)).toBe("Adjustment (increase)");
    expect(mapMovementType("XX", 99, -5)).toBe("Adjustment (decrease)");
  });

  it("the map covers all the movement families the operator asked for", () => {
    const labels = Object.values(MOVEMENT_TYPE_MAP);
    expect(labels).toContain("Sale");
    expect(labels).toContain("Purchase receipt");
    expect(labels).toContain("Credit / Return");
    expect(labels.some((l) => /Write-off/.test(l))).toBe(true);
    expect(labels.some((l) => /Adjustment/.test(l))).toBe(true);
  });
});
