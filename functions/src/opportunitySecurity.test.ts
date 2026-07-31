import assert from "node:assert/strict";
import test from "node:test";

import {
  isOpportunityAvailable,
  requireHttpsActionUrl,
  requireOpportunityId,
  requireOpportunityRequestId,
} from "./opportunitySecurity.js";

test("opportunity identifiers reject unsafe values", () => {
  assert.equal(requireOpportunityId("career_2026"), "career_2026");
  assert.equal(requireOpportunityRequestId("request_123"), "request_123");
  assert.throws(() => requireOpportunityId("../secret"));
  assert.throws(() => requireOpportunityRequestId("short"));
});

test("opportunity URLs require credential-free HTTPS", () => {
  assert.equal(
    requireHttpsActionUrl("https://partner.example/apply"),
    "https://partner.example/apply",
  );
  assert.throws(() => requireHttpsActionUrl("http://partner.example/apply"));
  assert.throws(() => requireHttpsActionUrl("https://user:pass@partner.example"));
});

test("opportunities must be published and within their active window", () => {
  const timestamp = (value: number) => ({toMillis: () => value});
  assert.equal(isOpportunityAvailable({status: "draft"}, 100), false);
  assert.equal(
    isOpportunityAvailable({
      status: "published",
      publishedAt: timestamp(50),
      expiresAt: timestamp(150),
    }, 100),
    true,
  );
  assert.equal(
    isOpportunityAvailable({
      status: "published",
      publishedAt: timestamp(110),
    }, 100),
    false,
  );
  assert.equal(
    isOpportunityAvailable({
      status: "published",
      expiresAt: timestamp(100),
    }, 100),
    false,
  );
});
