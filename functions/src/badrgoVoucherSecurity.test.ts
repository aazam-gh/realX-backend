/* eslint-disable max-len */
import assert from "node:assert/strict";
import {describe, it} from "node:test";
import {
  getNextQatarWeekIso,
  getQatarWeekKey,
  getVoucherEligibility,
  identityHash,
  normalizeVoucherCodes,
  voucherCodeDocumentId,
} from "./badrgoVoucherSecurity.js";

describe("Badrgo voucher security helpers", () => {
  it("normalizes arbitrary replenishment batches", () => {
    assert.deepEqual(normalizeVoucherCodes([" ride_001 ", "RIDE-002"]), [
      "RIDE_001",
      "RIDE-002",
    ]);
  });

  it("rejects duplicate and oversized imports", () => {
    assert.throws(() => normalizeVoucherCodes(["RIDE001", "ride001"]), /duplicate/);
    assert.throws(
      () => normalizeVoucherCodes(Array.from({length: 5001}, (_, i) => `RIDE${i + 100000}`)),
      /5000/
    );
  });

  it("creates stable non-plaintext code and identity keys", () => {
    assert.equal(voucherCodeDocumentId(" ride001 "), voucherCodeDocumentId("RIDE001"));
    assert.equal(identityHash("one", " Student@Example.com "), identityHash("two", "student@example.com"));
    assert.equal(voucherCodeDocumentId("RIDE001").includes("RIDE001"), false);
  });

  it("uses ISO weeks in Qatar time", () => {
    assert.equal(getQatarWeekKey(new Date("2026-09-06T20:59:59.000Z")), "2026-W36");
    assert.equal(getQatarWeekKey(new Date("2026-09-06T21:00:00.000Z")), "2026-W37");
    assert.equal(getNextQatarWeekIso(new Date("2026-09-09T10:00:00.000Z")), "2026-09-13T21:00:00.000Z");
  });

  it("requires redemption and a later week before another claim", () => {
    const base = {
      authenticated: true,
      programStatus: "active" as const,
      availableCount: 100,
      periodKey: "2026-W37",
    };
    assert.equal(getVoucherEligibility({...base, currentClaimStatus: "assigned"}), "previous_code_not_redeemed");
    assert.equal(getVoucherEligibility({...base, currentClaimStatus: "redeemed", lastClaimPeriodKey: "2026-W37"}), "already_claimed_this_week");
    assert.equal(getVoucherEligibility({...base, currentClaimStatus: "redeemed", lastClaimPeriodKey: "2026-W36"}), "eligible");
    assert.equal(getVoucherEligibility({...base, availableCount: 0}), "out_of_stock");
  });
});
