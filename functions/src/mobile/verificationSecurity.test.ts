import assert from 'node:assert/strict';
import test from 'node:test';
import { HttpsError } from 'firebase-functions/v2/https';
import {
  hashToken,
  parseVerificationImage,
  secureToken,
  secureTokenMatches,
} from './verificationSecurity';

test('status tokens only match their stored hash', () => {
  const token = secureToken();
  const tokenHash = hashToken(token);

  assert.equal(secureTokenMatches(token, tokenHash), true);
  assert.equal(secureTokenMatches(`${token}x`, tokenHash), false);
});

test('verification image parser accepts JPEG signatures', () => {
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0x00]).toString('base64');
  const result = parseVerificationImage(jpeg, 'Front');

  assert.equal(result.contentType, 'image/jpeg');
  assert.equal(result.extension, 'jpg');
});

test('verification image parser rejects arbitrary base64', () => {
  assert.throws(
    () => parseVerificationImage(Buffer.from('not an image').toString('base64'), 'Front'),
    (error) => error instanceof HttpsError && error.code === 'invalid-argument'
  );
});
