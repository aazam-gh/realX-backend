import assert from 'node:assert/strict';
import test from 'node:test';
import { HttpsError } from 'firebase-functions/v2/https';
import {
  hashPin,
  isAllowedGiftCardValue,
  parseRedemptionInput,
  requirePin,
  verifyPin,
} from './redemptionSecurity';

test('offer payload ignores privileged client fields', () => {
  const input = parseRedemptionInput({
    vendorId: 'vendor-1',
    totalAmount: '25.50',
    pin: '١٢٣٤',
    offerIndex: 2,
    creatorCode: 'ab12',
    uid: 'attacker-controlled',
    type: 'giftcard',
    vendorName: 'Fake vendor',
    discountAmount: 25.5,
  }, 'offer');

  assert.deepEqual(input, {
    vendorId: 'vendor-1',
    totalAmount: 25.5,
    pin: '1234',
    offerIndex: 2,
    creatorCode: 'AB12',
  });
});

test('gift card values must match vendor denominations', () => {
  assert.equal(isAllowedGiftCardValue(50, [25, 50, 75]), true);
  assert.equal(isAllowedGiftCardValue(49.99, [25, 50, 75]), false);
  assert.equal(isAllowedGiftCardValue(25, undefined), true);
});

test('gift card payload rejects values above the bill total', () => {
  assert.throws(
    () => parseRedemptionInput({
      vendorId: 'vendor-1',
      totalAmount: 20,
      giftCardAmount: 25,
      pin: '1234',
    }, 'giftcard'),
    (error) => error instanceof HttpsError && error.code === 'invalid-argument'
  );
});

test('PIN hashes verify without retaining plaintext', () => {
  const secret = hashPin('1234');

  assert.equal(verifyPin('1234', secret), true);
  assert.equal(verifyPin('4321', secret), false);
  assert.equal(JSON.stringify(secret).includes('1234'), false);
});

test('PIN validation preserves leading zeroes', () => {
  assert.equal(requirePin('0123'), '0123');
});
