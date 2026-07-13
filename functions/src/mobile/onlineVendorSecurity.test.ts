import assert from 'node:assert/strict';
import test from 'node:test';
import {
  MAX_TRACKED_ONLINE_CLICKS_PER_DAY,
  normalizeHttpsPurchaseUrl,
  normalizeOnlineClickRequestId,
  shouldTrackOnlineClick,
} from './onlineVendorSecurity';

test('online click request IDs reject missing, short, and unsafe values', () => {
  assert.equal(normalizeOnlineClickRequestId(undefined), null);
  assert.equal(normalizeOnlineClickRequestId('short'), null);
  assert.equal(normalizeOnlineClickRequestId('request/id-with-slash'), null);
  assert.equal(normalizeOnlineClickRequestId('online-m1234567-abcdefghi'), 'online-m1234567-abcdefghi');
});

test('online vendor URLs require HTTPS without embedded credentials', () => {
  assert.equal(normalizeHttpsPurchaseUrl('http://store.example.com'), null);
  assert.equal(normalizeHttpsPurchaseUrl('https://user:pass@store.example.com'), null);
  assert.equal(normalizeHttpsPurchaseUrl('not-a-url'), null);
  assert.equal(normalizeHttpsPurchaseUrl('https://store.example.com/deal'), 'https://store.example.com/deal');
});

test('abnormal click traffic is untracked without becoming an access decision', () => {
  assert.equal(shouldTrackOnlineClick(0), true);
  assert.equal(shouldTrackOnlineClick(MAX_TRACKED_ONLINE_CLICKS_PER_DAY - 1), true);
  assert.equal(shouldTrackOnlineClick(MAX_TRACKED_ONLINE_CLICKS_PER_DAY), false);
  assert.equal(shouldTrackOnlineClick(Number.NaN), false);
});
