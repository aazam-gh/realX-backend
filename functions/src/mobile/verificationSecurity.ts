import { createHash, randomBytes, timingSafeEqual } from 'crypto';
import { HttpsError } from 'firebase-functions/v2/https';

export const MAX_VERIFICATION_IMAGE_SIZE = 3 * 1024 * 1024;

export const hashToken = (value: string) =>
  createHash('sha256').update(value).digest('hex');

export const secureToken = () => randomBytes(32).toString('base64url');

export const secureTokenMatches = (token: string, expectedHash: unknown) => {
  if (typeof expectedHash !== 'string') return false;
  const actual = Buffer.from(hashToken(token), 'hex');
  const expected = Buffer.from(expectedHash, 'hex');
  return actual.length === expected.length && timingSafeEqual(actual, expected);
};

export const parseVerificationImage = (value: unknown, label: string) => {
  if (typeof value !== 'string' || value.length === 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) {
    throw new HttpsError('invalid-argument', `${label} image is malformed`);
  }

  const buffer = Buffer.from(value, 'base64');
  if (buffer.length === 0 || buffer.length > MAX_VERIFICATION_IMAGE_SIZE) {
    throw new HttpsError('invalid-argument', `${label} image must be non-empty and under 3MB`);
  }

  const isJpeg = buffer.length >= 3 &&
    buffer[0] === 0xff &&
    buffer[1] === 0xd8 &&
    buffer[2] === 0xff;
  const isPng = buffer.length >= 8 &&
    buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));

  if (!isJpeg && !isPng) {
    throw new HttpsError('invalid-argument', `${label} image must be JPEG or PNG`);
  }

  return {
    buffer,
    contentType: isJpeg ? 'image/jpeg' : 'image/png',
    extension: isJpeg ? 'jpg' : 'png',
  };
};
