import assert from "node:assert/strict";
import test from "node:test";

import {
  HARD_MAXIMUM_BYTES_BILLED,
  resolveMaximumBytesBilled,
} from "./bigquery-cost-controls.js";

test("uses the hard BigQuery byte ceiling by default", () => {
  assert.equal(
    resolveMaximumBytesBilled(undefined),
    HARD_MAXIMUM_BYTES_BILLED,
  );
});

test("allows configuration to lower the BigQuery byte ceiling", () => {
  assert.equal(resolveMaximumBytesBilled("10485760"), 10 * 1024 * 1024);
});

test("does not allow configuration to raise the BigQuery byte ceiling", () => {
  assert.equal(
    resolveMaximumBytesBilled(String(1024 * 1024 * 1024)),
    HARD_MAXIMUM_BYTES_BILLED,
  );
});

test("ignores invalid BigQuery byte configuration", () => {
  assert.equal(
    resolveMaximumBytesBilled("not-a-number"),
    HARD_MAXIMUM_BYTES_BILLED,
  );
});
