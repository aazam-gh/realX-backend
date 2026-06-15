import { HttpsError } from 'firebase-functions/v2/https';
import { randomBytes, scryptSync, timingSafeEqual } from 'crypto';

const PIN_HASH_KEY_LENGTH = 64;
const MAX_TRANSACTION_AMOUNT = 1_000_000;

export type RedemptionType = 'giftcard' | 'offer';

export type RedemptionInput = {
  vendorId: string;
  totalAmount: number;
  pin: string;
  giftCardAmount?: number;
  offerIndex?: number;
  creatorCode?: string;
};

export type VendorRedemptionSecret = {
  algorithm?: unknown;
  salt?: unknown;
  hash?: unknown;
};

export const normalizeDigits = (input: string | number | undefined | null): string => {
  if (input === null || input === undefined) return '';

  const arabic = '٠١٢٣٤٥٦٧٨٩';
  const persian = '۰۱۲۳۴۵۶۷۸۹';

  return String(input).replace(/[٠-٩۰-۹]/g, (digit) => {
    const arabicIndex = arabic.indexOf(digit);
    return arabicIndex > -1 ? arabicIndex.toString() : persian.indexOf(digit).toString();
  });
};

export const requireDocumentId = (value: unknown, fieldName: string): string => {
  if (
    typeof value !== 'string' ||
    value.length < 1 ||
    value.length > 200 ||
    value.includes('/')
  ) {
    throw new HttpsError('invalid-argument', `${fieldName} is invalid`);
  }

  return value;
};

const requireMoneyAmount = (
  value: unknown,
  fieldName: string,
  { allowZero = false }: { allowZero?: boolean } = {}
): number => {
  const normalized = Number.parseFloat(normalizeDigits(value as string | number));
  const minimum = allowZero ? 0 : 0.01;

  if (
    !Number.isFinite(normalized) ||
    normalized < minimum ||
    normalized > MAX_TRANSACTION_AMOUNT ||
    Math.abs(normalized * 100 - Math.round(normalized * 100)) > 0.000001
  ) {
    throw new HttpsError('invalid-argument', `${fieldName} is invalid`);
  }

  return normalized;
};

export const requirePin = (value: unknown): string => {
  const pin = normalizeDigits(value as string | number);
  if (!/^\d{4}$/.test(pin)) {
    throw new HttpsError('invalid-argument', 'Invalid PIN');
  }
  return pin;
};

const parseCreatorCode = (value: unknown): string | undefined => {
  if (value === undefined || value === null || value === '') return undefined;

  const creatorCode = normalizeDigits(value as string | number).trim().toUpperCase();
  if (!/^[A-Z]{2}\d{2}$/.test(creatorCode)) {
    throw new HttpsError('invalid-argument', 'Invalid creator code');
  }
  return creatorCode;
};

export const parseRedemptionInput = (data: unknown, type: RedemptionType): RedemptionInput => {
  const payload = data && typeof data === 'object' ? data as Record<string, unknown> : {};
  const totalAmount = requireMoneyAmount(payload.totalAmount, 'Total amount');
  const result: RedemptionInput = {
    vendorId: requireDocumentId(payload.vendorId, 'Vendor ID'),
    totalAmount,
    pin: requirePin(payload.pin),
  };

  if (type === 'giftcard') {
    const giftCardAmount = requireMoneyAmount(payload.giftCardAmount, 'Gift card amount');
    if (giftCardAmount > totalAmount) {
      throw new HttpsError('invalid-argument', 'Gift card amount cannot exceed total amount');
    }
    result.giftCardAmount = giftCardAmount;
    return result;
  }

  const offerIndex = Number(payload.offerIndex);
  if (!Number.isInteger(offerIndex) || offerIndex < 0 || offerIndex > 10_000) {
    throw new HttpsError('invalid-argument', 'Offer index is invalid');
  }

  result.offerIndex = offerIndex;
  result.creatorCode = parseCreatorCode(payload.creatorCode);
  return result;
};

export const hashPin = (pin: string) => {
  const salt = randomBytes(16);
  const hash = scryptSync(pin, salt, PIN_HASH_KEY_LENGTH);
  return {
    algorithm: 'scrypt',
    salt: salt.toString('base64'),
    hash: hash.toString('base64'),
  };
};

export const verifyPin = (inputPin: string, secret: VendorRedemptionSecret): boolean => {
  if (
    secret.algorithm !== 'scrypt' ||
    typeof secret.salt !== 'string' ||
    typeof secret.hash !== 'string'
  ) {
    return false;
  }

  try {
    const expectedHash = Buffer.from(secret.hash, 'base64');
    const actualHash = scryptSync(inputPin, Buffer.from(secret.salt, 'base64'), expectedHash.length);
    return expectedHash.length > 0 && timingSafeEqual(actualHash, expectedHash);
  } catch {
    return false;
  }
};

export const isAllowedGiftCardValue = (giftCardAmount: number, configuredValues: unknown): boolean => {
  const values = Array.isArray(configuredValues) && configuredValues.length > 0
    ? configuredValues
    : [25, 50, 75];
  const giftCardCents = Math.round(giftCardAmount * 100);

  return values
    .map((value) => Number(value))
    .filter((value) => Number.isFinite(value) && value > 0)
    .some((value) => Math.round(value * 100) === giftCardCents);
};
