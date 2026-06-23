//These are the cloud functions file


import * as admin from 'firebase-admin';
import { CallableRequest, HttpsError, onCall, onRequest } from 'firebase-functions/v2/https';
import { defineSecret } from 'firebase-functions/params';
import { Resend } from 'resend';
import '../global-options.js';
import {
  createHash,
  randomInt,
} from 'crypto';
import {
  hashPin,
  isAllowedGiftCardValue,
  normalizeDigits,
  parseRedemptionInput,
  RedemptionInput,
  RedemptionType,
  requireDocumentId,
  requirePin,
  verifyPin,
} from './redemptionSecurity';
import {
  hashToken,
  parseVerificationImage,
  secureToken,
  secureTokenMatches,
} from './verificationSecurity';
import { createGeospatialFunctions } from './geospatial';
import { createNotificationFunctions } from './notifications';
import {
  getRequestFingerprint,
  isAllowedStudentEmail,
  isValidDob,
  isValidEmail,
  isValidOtpPurpose,
  isValidSignupGender,
  isValidSignupRole,
} from './authSecurity';

if (admin.apps.length === 0) admin.initializeApp();

const RESEND_API_KEY = defineSecret('RESEND_API_KEY');
let _resend: Resend | null = null;
function getResend(): Resend {
  if (!_resend) {
    _resend = new Resend(RESEND_API_KEY.value());
  }
  return _resend;
}

const db = admin.firestore();
const {
  registerPushToken,
  sendCreatorCodeUsedPush,
  unregisterPushToken,
} = createNotificationFunctions(db);
export { registerPushToken, unregisterPushToken };
const getStorageBucket = () => {
  const projectId = process.env.GCLOUD_PROJECT || process.env.GCP_PROJECT || 'reelx-backend';
  const bucketName = process.env.FIREBASE_STORAGE_BUCKET ||
    (projectId === 'reelx-backend' ? 'reelx-backend' : `${projectId}.appspot.com`);

  return admin.storage().bucket(bucketName);
};
const REVIEW_EMAIL = (process.env.APPLE_REVIEW_EMAIL || 'apple-review@realx.qa').toLowerCase().trim();
/**
 * =============================
 * Utils
 * =============================
 */
const generateCode = () => {
  const letters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  const l1 = letters[Math.floor(Math.random() * 26)];
  const l2 = letters[Math.floor(Math.random() * 26)];
  const d1 = Math.floor(Math.random() * 10);
  const d2 = Math.floor(Math.random() * 10);
  return `${l1}${l2}${d1}${d2}`;
};

const toCents = (amount: number) => Math.round(amount * 100);
const fromCents = (cents: number) => cents / 100;

const hashDocId = (value: string) =>
  createHash('sha256').update(value).digest('hex');

const REDEMPTION_RATE_LIMIT_WINDOW_MS = 5 * 60 * 1000;
const MAX_REDEMPTIONS_PER_WINDOW = 10;
const assertAdmin = async (uid: string, hasAdminClaim = false) => {
  if (hasAdminClaim) return;

  const adminDoc = await db.collection('students').doc(uid).get();
  if (!adminDoc.exists || adminDoc.data()?.admin !== true) {
    throw new HttpsError('permission-denied', 'Admin access required');
  }
};

const checkEmailAndClientRateLimits = async (
  request: CallableRequest,
  action: string,
  email: string
) => {
  await Promise.all([
    checkAccountRateLimit(`${action}:email:${email}`),
    checkAccountRateLimit(`${action}:client:${getRequestFingerprint(request)}`),
  ]);
};

const getQatarDateKey = () => {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Qatar',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date());

  const valueFor = (type: string) => parts.find((part) => part.type === type)?.value || '';
  return `${valueFor('year')}-${valueFor('month')}-${valueFor('day')}`;
};

const getOnlineRedemptionConfig = async (vendorId: string) => {
  const [vendorDoc, configDoc] = await Promise.all([
    db.collection('vendors').doc(vendorId).get(),
    db.collection('vendorOnlineRedemptionConfigs').doc(vendorId).get(),
  ]);

  if (!vendorDoc.exists) {
    throw new HttpsError('not-found', 'Vendor not found');
  }

  const vendorData = vendorDoc.data() || {};
  if (vendorData.vendorType !== 'online') {
    throw new HttpsError('failed-precondition', 'This vendor is not available for online redemption');
  }

  if (!configDoc.exists) {
    throw new HttpsError('failed-precondition', 'Online redemption is not configured for this vendor');
  }

  const configData = configDoc.data() || {};
  const discountCode = typeof configData.discountCode === 'string' ? configData.discountCode.trim() : '';
  const purchaseUrl = typeof configData.purchaseUrl === 'string' ? configData.purchaseUrl.trim() : '';
  const dailyLimitPerUser = Number(configData.dailyLimitPerUser || 0);

  const configIsAvailable =
    configData.enabled === true &&
    !!discountCode &&
    !!purchaseUrl &&
    Number.isFinite(dailyLimitPerUser) &&
    dailyLimitPerUser >= 1;

  if (!configIsAvailable) {
    throw new HttpsError('failed-precondition', 'Online redemption is not available for this vendor');
  }

  return {
    vendorData,
    configData: {
      discountCode,
      purchaseUrl,
      dailyLimitPerUser: Math.floor(dailyLimitPerUser),
    },
  };
};


/**
 * =============================
 * Creator Code Helpers
 * =============================
 */
const validateCreatorCode = async (tx: admin.firestore.Transaction, creatorCode: string | null) => {
  if (!creatorCode) return null;

  const code = normalizeDigits(creatorCode).trim().toUpperCase();
  const codeRef = db.collection('creator_codes').doc(code);
  const codeDoc = await tx.get(codeRef);

  if (!codeDoc.exists) {
    throw new HttpsError('not-found', 'Invalid creator code');
  }

  const creatorUid = codeDoc.data()?.uid;
  const creatorRef = db.collection('students').doc(creatorUid);
  const creatorDoc = await tx.get(creatorRef);

  if (!creatorDoc.exists) {
    throw new HttpsError('not-found', 'Creator not found');
  }

  const creatorName = creatorDoc.data()?.name || null;

  return { creatorUid, creatorRef, code, creatorName };
};

/**
 * =============================
 * Pricing / Discount Logic
 * =============================
 */

const calculateDiscount = (
  totalCents: number,
  discountType: unknown,
  discountValue: unknown
) => {
  let discountCents = 0;
  const numericDiscountValue = Number(discountValue);

  if (!Number.isFinite(numericDiscountValue) || numericDiscountValue < 0) {
    throw new HttpsError('invalid-argument', 'Invalid discount value');
  }

  if (discountType === 'percentage') {
    discountCents = Math.round(totalCents * (numericDiscountValue / 100));
  } else if (discountType === 'amount') {
    discountCents = toCents(numericDiscountValue);
  } else if (discountType === 'buy1get1') {
    // No discount for buy1get1 - user pays full amount
    discountCents = 0;
  } else {
    throw new HttpsError('invalid-argument', 'Invalid discount type');
  }

  discountCents = Math.min(discountCents, totalCents);
  return discountCents;
};

/**
 * =============================
 * Cashback Logic (UPDATED RULES)
 * =============================
 */
const calculateCashback = ({
  finalCents,
  vendorData,
  creatorUid,
  type,
}: {
  finalCents: number;
  vendorData: Record<string, unknown>;
  creatorUid?: string | null;
  type: RedemptionType;
}) => {
  let userCashback = 0;
  let creatorCashback = 0;

  const isXcardVendor = vendorData.xcard === true;

  // ❌ No cashback for giftcards
  if (type === 'giftcard') {
    return { userCashback, creatorCashback };
  }

  if (!isXcardVendor) {
    return { userCashback, creatorCashback };
  }

  const cashbackCents = Math.round(finalCents * 0.01);

  // ✅ User always gets cashback for xcard vendor
  userCashback = cashbackCents;

  // ✅ Creator gets cashback if code used (even self-use)
  if (creatorUid) {
    creatorCashback = cashbackCents;
  }

  return { userCashback, creatorCashback };
};

/**
 * =============================
 * Core Transaction
 * =============================
 */
const checkRedemptionRateLimit = async (uid: string, vendorId: string) => {
  const now = admin.firestore.Timestamp.now();
  const rateRef = db
    .collection('redemption_rate_limits')
    .doc(hashDocId(`${uid}:${vendorId}`));

  await db.runTransaction(async (tx) => {
    const rateDoc = await tx.get(rateRef);
    const data = rateDoc.data() || {};
    const existingWindowStart = data.windowStart?.toMillis?.() ?? 0;
    const isCurrentWindow = now.toMillis() - existingWindowStart < REDEMPTION_RATE_LIMIT_WINDOW_MS;
    const attemptCount = isCurrentWindow ? Number(data.attemptCount || 0) : 0;

    if (attemptCount >= MAX_REDEMPTIONS_PER_WINDOW) {
      console.warn('Redemption rate limit exceeded', { uid, vendorId });
      throw new HttpsError('resource-exhausted', 'Too many redemption attempts. Please try again later.');
    }

    tx.set(rateRef, {
      uid,
      vendorId,
      attemptCount: attemptCount + 1,
      windowStart: isCurrentWindow ? data.windowStart : now,
      updatedAt: now,
      expiresAt: admin.firestore.Timestamp.fromMillis(now.toMillis() + REDEMPTION_RATE_LIMIT_WINDOW_MS),
    });
  });
};

const processTransaction = async ({
  uid,
  type,
  input,
}: {
  uid: string;
  type: RedemptionType;
  input: RedemptionInput;
}) => {
  const {
    vendorId,
    totalAmount,
    pin,
    giftCardAmount = 0,
    offerIndex = null,
    creatorCode = null,
  } = input;

  const userRef = db.collection('students').doc(uid);
  const vendorRef = db.collection('vendors').doc(vendorId);
  const secretRef = db.collection('vendorRedemptionSecrets').doc(vendorId);
  const transactionRef = db.collection('transactions').doc();

  return db.runTransaction(async (tx) => {
    /**
     * =============================
     * 1. READS
     * =============================
     */
    const [userDoc, vendorDoc, secretDoc] = await Promise.all([
      tx.get(userRef),
      tx.get(vendorRef),
      tx.get(secretRef),
    ]);

    if (!userDoc.exists) throw new HttpsError('not-found', 'User not found');
    if (!vendorDoc.exists) throw new HttpsError('not-found', 'Vendor not found');
    if (!secretDoc.exists) {
      throw new HttpsError('failed-precondition', 'Vendor redemption is not configured');
    }

    const userData = userDoc.data() || {};
    const vendorData = vendorDoc.data() || {};
    const vendorName = typeof vendorData.name === 'string' ? vendorData.name : '';

    if (userData.redemptionDisabled === true || userData.accountType === 'browse_only') {
      throw new HttpsError('permission-denied', 'This account cannot make redemptions');
    }

    /**
     * =============================
     * 2. PIN VALIDATION
     * =============================
     */
    if (!verifyPin(pin, secretDoc.data() || {})) {
      console.warn('Redemption rejected: invalid PIN', { uid, vendorId, type });
      throw new HttpsError('permission-denied', 'Invalid PIN');
    }

    /**
     * =============================
     * 3. AMOUNTS
     * =============================
     */
    const totalCents = toCents(totalAmount);
    let discountCents = 0;
    let finalCents = totalCents;
    let giftcardSavingsCents = 0;

    /**
     * =============================
     * 4. OFFER LOGIC (from vendor's embedded offers)
     * =============================
     */
    let creatorData = null;
    let appliedOffer = null;

    if (type !== 'giftcard') {
      if (offerIndex !== null && offerIndex !== undefined) {
        const vendorOffers = vendorData.offers || [];
        if (offerIndex < 0 || offerIndex >= vendorOffers.length) {
          throw new HttpsError('not-found', 'Offer not found for this vendor');
        }
        appliedOffer = vendorOffers[offerIndex];
        if (!appliedOffer || appliedOffer.isActive === false) {
          throw new HttpsError('failed-precondition', 'Offer is not available');
        }

        // For buy1get1, no discount value needed
        const discountArg = appliedOffer.discountType === 'buy1get1'
          ? 0
          : appliedOffer.discountValue;

        discountCents = calculateDiscount(
          totalCents,
          appliedOffer.discountType,
          discountArg
        );
        finalCents = totalCents - discountCents;
      }

      creatorData = await validateCreatorCode(tx, creatorCode);
    }

    /**
     * =============================
     * 5. GIFT CARD LOGIC
     * =============================
     */
    if (type === 'giftcard') {
      const balance = toCents(userData.cashback || 0);
      const redeemCents = toCents(giftCardAmount);
      if (!isAllowedGiftCardValue(giftCardAmount, vendorData.loyalty)) {
        throw new HttpsError('invalid-argument', 'Gift card value is not available for this vendor');
      }
      giftcardSavingsCents = redeemCents;

      if (balance < redeemCents) {
        throw new HttpsError('failed-precondition', 'Insufficient balance');
      }

      finalCents = Math.max(0, totalCents - redeemCents);

      tx.update(userRef, {
        cashback: admin.firestore.FieldValue.increment(-fromCents(redeemCents)),
      });
    }

    /**
     * =============================
     * 6. CASHBACK
     * =============================
     */
    const { userCashback, creatorCashback } = calculateCashback({
      finalCents,
      vendorData,
      creatorUid: creatorData?.creatorUid,
      type,
    });

    /**
     * =============================
     * 7. WRITE TRANSACTION
     * =============================
     */
    tx.set(transactionRef, {
      type,
      userId: uid,
      vendorId,
      vendorName,
      vendorNameAr: typeof vendorData.nameAr === 'string' ? vendorData.nameAr : null,
      totalAmount,
      discountAmount: fromCents(discountCents),
      finalAmount: fromCents(finalCents),
      creatorCode: creatorData?.code || null,
      creatorUid: creatorData?.creatorUid || null,
      cashbackAmount: fromCents(userCashback),
      creatorCashbackAmount: fromCents(creatorCashback),
      offer: appliedOffer || null,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    /**
     * =============================
     * 8. UPDATE USER
     * =============================
     */
    const userUpdates: Record<string, admin.firestore.FieldValue> = {};

    const totalSavingsCents = discountCents + giftcardSavingsCents;

    if (totalSavingsCents > 0) {
      userUpdates.savings =
        admin.firestore.FieldValue.increment(fromCents(totalSavingsCents));
    }

    if (userCashback > 0) {
      userUpdates.cashback =
        admin.firestore.FieldValue.increment(fromCents(userCashback));
    }

    if (Object.keys(userUpdates).length > 0) {
      tx.update(userRef, userUpdates);
    }

    /**
     * =============================
     * 9. UPDATE CREATOR
     * =============================
     */
    if (creatorData?.creatorRef && creatorCashback > 0) {
      tx.update(creatorData.creatorRef, {
        cashback: admin.firestore.FieldValue.increment(
          fromCents(creatorCashback)
        ),
      });
    }

    // Total cashback for the redeeming user (self-use = double)
    const totalUserCashbackCents =
      creatorData?.creatorUid === uid
        ? userCashback + creatorCashback
        : userCashback;

    const savedAmountCents =
      appliedOffer?.discountType === 'buy1get1'
        ? totalCents
        : discountCents + giftcardSavingsCents;

    return {
      transactionId: transactionRef.id,
      finalAmount: fromCents(finalCents),
      discountAmount: fromCents(discountCents),
      savedAmount: fromCents(savedAmountCents),
      cashbackAmount: fromCents(totalUserCashbackCents),
      creatorUid: creatorData?.creatorUid || null,
      creatorName: creatorData?.creatorName || null,
      creatorCashback: fromCents(creatorCashback),
      vendorName,
    };
  });
};

export const {
  backfillVendorGeohashes,
  syncVendorGeohash,
} = createGeospatialFunctions(db);

/**
 * =============================
 * Public Functions
 * =============================
 */
export const setVendorRedemptionPin = onCall(
  async (request: CallableRequest) => {
    if (!request.auth) {
      throw new HttpsError('unauthenticated', 'Login required');
    }

    await assertAdmin(request.auth.uid, request.auth.token.admin === true);
    const vendorId = requireDocumentId(request.data?.vendorId, 'Vendor ID');
    const pin = requirePin(request.data?.pin);
    const vendorRef = db.collection('vendors').doc(vendorId);
    const secretRef = db.collection('vendorRedemptionSecrets').doc(vendorId);
    const adminPinRef = db.collection('vendor_pins').doc(vendorId);

    await db.runTransaction(async (tx) => {
      const vendorDoc = await tx.get(vendorRef);
      if (!vendorDoc.exists) {
        throw new HttpsError('not-found', 'Vendor not found');
      }

      const updatedAt = admin.firestore.FieldValue.serverTimestamp();
      tx.set(secretRef, {
        ...hashPin(pin),
        vendorId,
        rotatedBy: request.auth?.uid,
        updatedAt,
      });
      tx.set(adminPinRef, {
        vendorId,
        pin,
        rotatedBy: request.auth?.uid,
        updatedAt,
      });
    });

    console.info('Vendor redemption PIN rotated', {
      vendorId,
      adminUid: request.auth.uid,
    });
    return { success: true };
  }
);

export const redeemGiftCard = onCall(
  { enforceAppCheck: true },
  async (request: CallableRequest) => {
    if (!request.auth) {
      throw new HttpsError('unauthenticated', 'Login required');
    }

    const input = parseRedemptionInput(request.data, 'giftcard');
    await checkRedemptionRateLimit(request.auth.uid, input.vendorId);
    const result = await processTransaction({ uid: request.auth.uid, type: 'giftcard', input });

    console.info('Gift card redemption completed', {
      uid: request.auth.uid,
      vendorId: input.vendorId,
      transactionId: result.transactionId,
    });
    return result;
  }
);

export const redeemOffer = onCall(
  { enforceAppCheck: true },
  async (request: CallableRequest) => {
    if (!request.auth) {
      throw new HttpsError('unauthenticated', 'Login required');
    }

    const input = parseRedemptionInput(request.data, 'offer');
    await checkRedemptionRateLimit(request.auth.uid, input.vendorId);
    const result = await processTransaction({ uid: request.auth.uid, type: 'offer', input });

    if (result?.creatorUid && result?.creatorCashback > 0) {
      await sendCreatorCodeUsedPush({
        creatorUid: result.creatorUid,
        vendorName: result.vendorName || 'a vendor',
        cashbackAmount: result.creatorCashback,
        transactionId: result.transactionId,
      });
    }

    console.info('Offer redemption completed', {
      uid: request.auth.uid,
      vendorId: input.vendorId,
      transactionId: result.transactionId,
    });
    return result;
  }
);

export const getOnlineRedemptionPreview = onCall(
  { enforceAppCheck: true },
  async (request: CallableRequest) => {
    if (!request.auth) {
      throw new HttpsError('unauthenticated', 'Login required');
    }

    const vendorId = typeof request.data?.vendorId === 'string' ? request.data.vendorId : '';
    if (!vendorId) {
      throw new HttpsError('invalid-argument', 'Vendor ID is required');
    }

    const { configData } = await getOnlineRedemptionConfig(vendorId);
    const dateKey = getQatarDateKey();
    const counterId = `${vendorId}_${dateKey}`;
    const counterDoc = await db
      .collection('students')
      .doc(request.auth.uid)
      .collection('onlineRedemptionCounters')
      .doc(counterId)
      .get();

    const usedToday = Number(counterDoc.data()?.count || 0);

    return {
      discountCode: configData.discountCode,
      dailyLimitPerUser: configData.dailyLimitPerUser,
      remainingToday: Math.max(0, configData.dailyLimitPerUser - usedToday),
      dateKey,
    };
  }
);

export const redeemOnlineVendor = onCall(
  { enforceAppCheck: true },
  async (request: CallableRequest) => {
    if (!request.auth) {
      throw new HttpsError('unauthenticated', 'Login required');
    }

    const uid = request.auth.uid;
    const vendorId = typeof request.data?.vendorId === 'string' ? request.data.vendorId : '';
    if (!vendorId) {
      throw new HttpsError('invalid-argument', 'Vendor ID is required');
    }

    const vendorRef = db.collection('vendors').doc(vendorId);
    const configRef = db.collection('vendorOnlineRedemptionConfigs').doc(vendorId);
    const dateKey = getQatarDateKey();
    const counterRef = db
      .collection('students')
      .doc(uid)
      .collection('onlineRedemptionCounters')
      .doc(`${vendorId}_${dateKey}`);
    const transactionRef = db.collection('transactions').doc();

    return db.runTransaction(async (tx) => {
      const [userDoc, vendorDoc, configDoc, counterDoc] = await Promise.all([
        tx.get(db.collection('students').doc(uid)),
        tx.get(vendorRef),
        tx.get(configRef),
        tx.get(counterRef),
      ]);

      if (!userDoc.exists) throw new HttpsError('not-found', 'User not found');
      if (!vendorDoc.exists) throw new HttpsError('not-found', 'Vendor not found');

      const vendorData = vendorDoc.data() || {};
      if (vendorData.vendorType !== 'online') {
        throw new HttpsError('failed-precondition', 'This vendor is not available for online redemption');
      }

      if (!configDoc.exists) {
        throw new HttpsError('failed-precondition', 'Online redemption is not configured for this vendor');
      }

      const configData = configDoc.data() || {};
      const discountCode = typeof configData.discountCode === 'string' ? configData.discountCode.trim() : '';
      const purchaseUrl = typeof configData.purchaseUrl === 'string' ? configData.purchaseUrl.trim() : '';
      const dailyLimitPerUser = Math.floor(Number(configData.dailyLimitPerUser || 0));

      const configIsAvailable =
        configData.enabled === true &&
        !!discountCode &&
        !!purchaseUrl &&
        Number.isFinite(dailyLimitPerUser) &&
        dailyLimitPerUser >= 1;

      if (!configIsAvailable) {
        throw new HttpsError('failed-precondition', 'Online redemption is not available for this vendor');
      }

      const usedToday = Number(counterDoc.data()?.count || 0);
      if (usedToday >= dailyLimitPerUser) {
        throw new HttpsError('resource-exhausted', 'Daily online redemption limit reached');
      }

      tx.set(transactionRef, {
        type: 'online_redemption',
        status: 'completed',
        userId: uid,
        vendorId,
        vendorName: vendorData.name || '',
        vendorNameAr: vendorData.nameAr || null,
        discountCode,
        purchaseUrl,
        onlineRedemptionDateKey: dateKey,
        totalAmount: 0,
        discountAmount: 0,
        finalAmount: 0,
        cashbackAmount: 0,
        creatorCashbackAmount: 0,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
      });

      tx.set(counterRef, {
        vendorId,
        dateKey,
        count: admin.firestore.FieldValue.increment(1),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      }, { merge: true });

      return {
        transactionId: transactionRef.id,
        purchaseUrl,
        discountCode,
        remainingToday: Math.max(0, dailyLimitPerUser - usedToday - 1),
      };
    });
  }
);

/**
 * =============================
 * Creator Code Assignment
 * =============================
 */
const reserveCreatorCode = async (tx: admin.firestore.Transaction, uid: string) => {
  let attempts = 0;

  while (attempts < 5) {
    const candidate = generateCode();
    const codeRef = db.collection('creator_codes').doc(candidate);
    const codeDoc = await tx.get(codeRef);

    if (!codeDoc.exists) {
      tx.set(codeRef, {
        uid,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
      });

      return candidate;
    }

    attempts++;
  }

  throw new HttpsError('internal', 'Failed to generate code');
};

export const assignCreatorCode = onCall(
  { enforceAppCheck: true },
  async (request: CallableRequest) => {
    if (!request.auth) {
      throw new HttpsError('unauthenticated', 'Must be logged in');
    }

    const uid = request.auth.uid;
    const userRef = db.collection('students').doc(uid);

    return db.runTransaction(async (tx) => {
      const userDoc = await tx.get(userRef);

      if (!userDoc.exists) {
        throw new HttpsError('not-found', 'User not found');
      }

      const existingCode = userDoc.data()?.creatorCode;
      if (existingCode) {
        return { creatorCode: existingCode };
      }

      const code = await reserveCreatorCode(tx, uid);
      tx.update(userRef, {
        creatorCode: code,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });

      return { creatorCode: code };
    });
  }
);

/**
 * =============================
 * Student Check
 * =============================
 */
const WAKTI_API_KEY_HEADER = 'x-wakti-api-key';
export const verifyWaktiStudent = onRequest(
  { secrets: ['WAKTI_API_KEY'] },
  async (request, response) => {
    if (request.method !== 'POST') {
      response.set('Allow', 'POST');
      response.status(405).json({ error: 'Method not allowed' });
      return;
    }

    const configuredApiKey = process.env.WAKTI_API_KEY;
    const requestApiKey = request.get(WAKTI_API_KEY_HEADER);

    if (!configuredApiKey || !requestApiKey || requestApiKey !== configuredApiKey) {
      console.warn('Wakti student verification rejected: invalid API key');
      response.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const email = typeof request.body?.email === 'string'
      ? request.body.email.trim().toLowerCase()
      : '';

    if (!email || !isValidEmail(email)) {
      response.status(400).json({ error: 'Valid email required' });
      return;
    }

    const snapshot = await db
      .collection('students')
      .where('email', '==', email)
      .limit(1)
      .get();
    const isStudent = !snapshot.empty;

    console.info('Wakti student verification completed', {
      isStudent,
    });

    await db.collection('wakti_student_verification_requests').add({
      email,
      isStudent,
      status: 'success',
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    response.status(200).json({ isStudent });
  }
);

export const checkStudentExists = onCall(
  { enforceAppCheck: true },
  async (request: CallableRequest) => {
    const email = request.data?.email?.toLowerCase()?.trim();

    if (!email) {
      throw new HttpsError('invalid-argument', 'Email required');
    }

    if (!isAllowedStudentEmail(email)) {
      throw new HttpsError(
        'permission-denied',
        'Only approved school emails can sign up'
      );
    }

    await checkEmailAndClientRateLimits(request, 'check_student', email);

    const snapshot = await db
      .collection('students')
      .where('email', '==', email)
      .limit(1)
      .get();

    return { exists: !snapshot.empty };
  }
);

export const checkStudentExistsLogin = onCall(
  { enforceAppCheck: true },
  async (request: CallableRequest) => {
    const email = request.data?.email?.toLowerCase()?.trim();

    if (!email) {
      throw new HttpsError('invalid-argument', 'Email required');
    }

    await checkEmailAndClientRateLimits(request, 'check_login', email);

    const snapshot = await db
      .collection('students')
      .where('email', '==', email)
      .limit(1)
      .get();

    return { exists: !snapshot.empty };
  }
);

/**
 * =============================
 * OTP Auth Constants
 * =============================
 */
const OTP_EXPIRY_MINUTES = 5;
const MAX_OTP_SENDS_PER_WINDOW = 5;
const RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000; // 15 minutes
const COOLDOWN_MS = 60 * 1000; // 60 seconds
const MAX_VERIFY_ATTEMPTS = 3;
const getOtpRef = (email: string) =>
  db.collection('otps').doc(hashDocId(`otp:${email}`));

const generateOtpCode = () => randomInt(100000, 1000000).toString();

/**
 * =============================
 * Account Check Rate Limiting
 * =============================
 */
const ACCOUNT_CHECK_RATE_LIMIT_MS = 15 * 60 * 1000; // 15 minutes
const MAX_ACCOUNT_CHECKS_PER_WINDOW = 20;

async function checkAccountRateLimit(key: string): Promise<void> {
  const now = admin.firestore.Timestamp.now();
  const rateRef = db.collection('rate_limits').doc(hashDocId(`account_check:${key}`));

  await db.runTransaction(async (tx) => {
    const rateDoc = await tx.get(rateRef);
    let checkCount = 1;
    let windowStart = now;

    if (rateDoc.exists) {
      const data = rateDoc.data();
      const existingWindowStart = data?.windowStart?.toMillis() ?? 0;
      const windowAge = now.toMillis() - existingWindowStart;

      if (windowAge < ACCOUNT_CHECK_RATE_LIMIT_MS) {
        const currentCount = data?.checkCount ?? 0;
        if (currentCount >= MAX_ACCOUNT_CHECKS_PER_WINDOW) {
          throw new HttpsError(
            'resource-exhausted',
            'Too many requests. Please try again later.'
          );
        }

        checkCount = currentCount + 1;
        windowStart = data?.windowStart ?? now;
      }
    }

    tx.set(rateRef, {
      checkCount,
      windowStart,
      updatedAt: now,
      expiresAt: admin.firestore.Timestamp.fromMillis(now.toMillis() + ACCOUNT_CHECK_RATE_LIMIT_MS),
    });
  });
}

/**
 * =============================
 * Send OTP
 * =============================
 */
export const sendOtp = onCall(
  { secrets: [RESEND_API_KEY], enforceAppCheck: true },
  async (request: CallableRequest) => {
    const email = request.data?.email?.toLowerCase()?.trim();
    const purpose = request.data?.purpose; // "signup" | "login" | "verification"

    if (!email || !isValidEmail(email)) {
      throw new HttpsError('invalid-argument', 'A valid email is required');
    }

    if (!isValidOtpPurpose(purpose)) {
      throw new HttpsError('invalid-argument', 'Purpose must be "signup", "login", or "verification"');
    }

    await checkEmailAndClientRateLimits(request, `send_otp_${purpose}`, email);

    // Signup: restrict to approved school email domains
    if (purpose === 'signup') {
      if (!isAllowedStudentEmail(email)) {
        throw new HttpsError('permission-denied', 'Only approved school emails can sign up');
      }

      // Check if account already exists
      const snapshot = await db
        .collection('students')
        .where('email', '==', email)
        .limit(1)
        .get();

      if (!snapshot.empty) {
        throw new HttpsError('already-exists', 'An account with this email already exists');
      }
    }

    // Verification: no .edu.qa restriction, just check no existing account
    if (purpose === 'verification') {
      const snapshot = await db
        .collection('students')
        .where('email', '==', email)
        .limit(1)
        .get();

      if (!snapshot.empty) {
        throw new HttpsError('already-exists', 'An account with this email already exists');
      }
    }

    // App Store Review Bypass
    if (REVIEW_EMAIL && email === REVIEW_EMAIL && purpose === 'login') {
      let uid: string;
      try {
        uid = (await admin.auth().getUserByEmail(email)).uid;
      } catch {
        uid = (await admin.auth().createUser({ email, emailVerified: true })).uid;
      }

      const studentRef = db.collection('students').doc(uid);
      if (!(await studentRef.get()).exists) {
        await studentRef.set({
          email,
          firstName: 'Apple',
          lastName: 'Review',
          dob: '2000-01-01',
          gender: 'Male',
          role: 'student',
          cashback: 0,
          uid,
          createdAt: admin.firestore.FieldValue.serverTimestamp(),
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        });
      }

      const customToken = await admin.auth().createCustomToken(uid);
      return { success: true, customToken };
    }

    // Login: verify account exists
    if (purpose === 'login') {
      const snapshot = await db
        .collection('students')
        .where('email', '==', email)
        .limit(1)
        .get();

      if (snapshot.empty) {
        throw new HttpsError('not-found', 'No account found with this email');
      }
    }

    const now = admin.firestore.Timestamp.now();
    const otpRef = getOtpRef(email);
    const { code } = await db.runTransaction(async (tx) => {
      const otpDoc = await tx.get(otpRef);

      if (otpDoc.exists) {
        const data = otpDoc.data();
        if (!data) throw new HttpsError('internal', 'Failed to read OTP data.');
        const rateWindowStart = data.rateLimit?.windowStart?.toMillis() ?? 0;
        const rateWindowAge = now.toMillis() - rateWindowStart;

        if (rateWindowAge < RATE_LIMIT_WINDOW_MS) {
          const currentSendCount = data.rateLimit?.sendCount ?? 0;
          if (currentSendCount >= MAX_OTP_SENDS_PER_WINDOW) {
            const retryAfterMinutes = Math.ceil((RATE_LIMIT_WINDOW_MS - rateWindowAge) / 60000);
            throw new HttpsError(
              'resource-exhausted',
              `Too many OTP requests. Try again in ${retryAfterMinutes} minutes.`
            );
          }
        }

        const lastSent = data.createdAt?.toMillis() ?? 0;
        const elapsed = now.toMillis() - lastSent;
        if (elapsed < COOLDOWN_MS) {
          const retryAfter = Math.ceil((COOLDOWN_MS - elapsed) / 1000);
          throw new HttpsError(
            'resource-exhausted',
            `Please wait ${retryAfter} seconds before requesting a new code.`,
            { retryAfter }
          );
        }
      }

      const nextCode = generateOtpCode();
      let sendCount = 1;
      let windowStart = now;

      if (otpDoc.exists) {
        const data = otpDoc.data();
        if (!data) throw new HttpsError('internal', 'Failed to read OTP data.');
        const existingWindowStart = data.rateLimit?.windowStart?.toMillis() ?? 0;
        const windowAge = now.toMillis() - existingWindowStart;

        if (windowAge < RATE_LIMIT_WINDOW_MS) {
          sendCount = (data.rateLimit?.sendCount ?? 0) + 1;
          windowStart = data.rateLimit?.windowStart ?? now;
        }
      }

      tx.set(otpRef, {
        email,
        code: nextCode,
        attempts: 0,
        createdAt: now,
        expiresAt: admin.firestore.Timestamp.fromMillis(now.toMillis() + OTP_EXPIRY_MINUTES * 60 * 1000),
        purpose,
        verified: false,
        rateLimit: { sendCount, windowStart },
        updatedAt: now,
      });

      return { code: nextCode };
    });

    // Send email via Resend
    try {
      await getResend().emails.send({
        from: 'realX <welcome@realx.qa>',
        to: email,
        subject: 'Your realX Verification Code',
        html: `
        <div style="font-family: Arial, sans-serif; max-width: 480px;
          margin: 0 auto; padding: 32px;">
          <h1 style="color: #18B852; font-size: 24px;
            margin-bottom: 24px;">realX</h1>
          <p style="font-size: 16px; color: #333;
            margin-bottom: 16px;">Your verification code is:</p>
          <div style="background: #f5f5f5; border-radius: 12px;
            padding: 20px; text-align: center; margin-bottom: 24px;">
            <span style="font-size: 36px; font-weight: bold;
              letter-spacing: 8px; color: #18B852;">${code}</span>
          </div>
          <p style="font-size: 14px; color: #666; margin-bottom: 8px;">
            This code expires in ${OTP_EXPIRY_MINUTES} minutes.</p>
          <p style="font-size: 14px; color: #999;">If you didn't request
            this code, you can safely ignore this email.</p>
        </div>
      `,
      });
    } catch (error) {
      console.error('Failed to send OTP email:', error);
      throw new HttpsError('internal', 'Failed to send verification email. Please try again.');
    }

    return { success: true };
  }
);

/**
 * =============================
 * Verify OTP
 * =============================
 */
export const verifyOtp = onCall(
  { enforceAppCheck: true },
  async (request: CallableRequest) => {
    const email = request.data?.email?.toLowerCase()?.trim();
    const code = request.data?.code?.trim();
    const purpose = request.data?.purpose;

    if (!email || !isValidEmail(email)) {
      throw new HttpsError('invalid-argument', 'A valid email is required');
    }

    if (!code || !/^\d{6}$/.test(code)) {
      throw new HttpsError('invalid-argument', 'A valid 6-digit code is required');
    }

    if (!isValidOtpPurpose(purpose)) {
      throw new HttpsError('invalid-argument', 'Purpose must be "signup", "login", or "verification"');
    }

    const now = admin.firestore.Timestamp.now();
    const otpRef = getOtpRef(email);
    const verificationResult = await db.runTransaction(async (tx) => {
      const otpDoc = await tx.get(otpRef);

      if (!otpDoc.exists) {
        throw new HttpsError('not-found', 'No verification code found. Please request a new one.');
      }

      const data = otpDoc.data();
      if (!data) throw new HttpsError('internal', 'Failed to read OTP data.');

      if (data.purpose !== purpose) {
        throw new HttpsError('permission-denied', 'This code is not valid for this action. Please request a new code.');
      }

      if (data.verified) {
        throw new HttpsError('permission-denied', 'This code has already been used. Please request a new one.');
      }

      if (data.expiresAt.toMillis() < now.toMillis()) {
        throw new HttpsError('deadline-exceeded', 'Code has expired. Please request a new one.');
      }

      const currentAttempts = data.attempts ?? 0;
      if (currentAttempts >= MAX_VERIFY_ATTEMPTS) {
        throw new HttpsError('resource-exhausted', 'Too many attempts. Please request a new code.');
      }

      const nextAttempts = currentAttempts + 1;

      if (data.code !== code) {
        const remaining = MAX_VERIFY_ATTEMPTS - nextAttempts;
        tx.update(otpRef, {
          attempts: nextAttempts,
          lastAttemptAt: now,
          updatedAt: now,
        });
        return {
          success: false,
          code: 'invalid-argument',
          message: `Incorrect code. ${remaining} attempt${remaining !== 1 ? 's' : ''} remaining.`,
        };
      }

      tx.update(otpRef, {
        attempts: nextAttempts,
        verified: true,
        verifiedAt: now,
        updatedAt: now,
      });

      return { success: true };
    });

    if (!verificationResult.success) {
      throw new HttpsError('invalid-argument', verificationResult.message || 'Incorrect code');
    }

    // Verification: just confirm email is verified, no auth user creation
    if (purpose === 'verification') {
      return { success: true, emailVerified: true };
    }

    let uid: string;

    if (purpose === 'signup') {
    // Create Firebase Auth user (or get existing)
      try {
        const userRecord = await admin.auth().getUserByEmail(email);
        uid = userRecord.uid;
        if (!userRecord.emailVerified) {
          await admin.auth().updateUser(uid, { emailVerified: true });
        }
      } catch {
        const userRecord = await admin.auth().createUser({
          email,
          emailVerified: true,
        });
        uid = userRecord.uid;
      }
    } else {
    // Login: look up UID from students collection
      const snapshot = await db
        .collection('students')
        .where('email', '==', email)
        .limit(1)
        .get();

      if (snapshot.empty) {
        throw new HttpsError('not-found', 'No account found with this email');
      }

      uid = snapshot.docs[0].id;
    }

    // Generate custom token
    const customToken = await admin.auth().createCustomToken(uid);

    return { success: true, customToken };
  }
);

/**
 * =============================
 * Signup Completion
 * =============================
 */
export const completeSignup = onCall(
  { enforceAppCheck: true },
  async (request: CallableRequest) => {
    if (!request.auth) {
      throw new HttpsError('unauthenticated', 'Login required');
    }

    const uid = request.auth.uid;
    const userRecord = await admin.auth().getUser(uid);
    const authEmail = userRecord.email?.toLowerCase()?.trim() || '';
    const requestedEmail = request.data?.email?.toLowerCase()?.trim() || authEmail;
    const firstName = typeof request.data?.firstName === 'string' ? request.data.firstName.trim() : '';
    const lastName = typeof request.data?.lastName === 'string' ? request.data.lastName.trim() : '';
    const dob = request.data?.dob;
    const gender = request.data?.gender;
    const role = request.data?.role || 'student';

    if (!authEmail || !requestedEmail || authEmail !== requestedEmail || !isValidEmail(requestedEmail)) {
      throw new HttpsError('permission-denied', 'Authenticated email does not match signup email');
    }

    if (!isAllowedStudentEmail(requestedEmail)) {
      throw new HttpsError('permission-denied', 'Only approved school emails can complete self-signup');
    }

    if (!firstName || !lastName || firstName.length > 80 || lastName.length > 80) {
      throw new HttpsError('invalid-argument', 'First and last name are required');
    }

    if (!isValidDob(dob)) {
      throw new HttpsError('invalid-argument', 'Valid date of birth is required');
    }

    if (!isValidSignupGender(gender)) {
      throw new HttpsError('invalid-argument', 'Valid gender is required');
    }

    if (!isValidSignupRole(role)) {
      throw new HttpsError('invalid-argument', 'Valid role is required');
    }

    const existingEmailSnapshot = await db
      .collection('students')
      .where('email', '==', requestedEmail)
      .limit(1)
      .get();

    if (!existingEmailSnapshot.empty && existingEmailSnapshot.docs[0].id !== uid) {
      throw new HttpsError('already-exists', 'An account with this email already exists');
    }

    const studentRef = db.collection('students').doc(uid);

    return db.runTransaction(async (tx) => {
      const studentDoc = await tx.get(studentRef);

      if (studentDoc.exists) {
        const existingData = studentDoc.data() || {};
        const existingEmail = existingData.email?.toLowerCase?.().trim?.() || '';

        if (existingEmail && existingEmail !== requestedEmail) {
          throw new HttpsError('permission-denied', 'Account email mismatch');
        }

        if (existingData.role === 'creator' && !existingData.creatorCode) {
          const creatorCode = await reserveCreatorCode(tx, uid);
          tx.update(studentRef, {
            creatorCode,
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
          });
          return { success: true, alreadyExists: true, creatorCode };
        }

        return {
          success: true,
          alreadyExists: true,
          creatorCode: existingData.creatorCode || null,
        };
      }

      const studentData: Record<string, unknown> = {
        firstName,
        lastName,
        dob,
        gender,
        email: requestedEmail,
        role,
        cashback: 0,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        uid,
      };

      let creatorCode = null;
      if (role === 'creator') {
        creatorCode = await reserveCreatorCode(tx, uid);
        studentData.creatorCode = creatorCode;
      }

      tx.create(studentRef, studentData);

      return { success: true, creatorCode };
    });
  }
);
/**
 * =============================
 * Student ID Verification
 * =============================
 */
const VERIFICATION_MAX_SUBMISSIONS = 3;
const VERIFICATION_RATE_LIMIT_MS = 60 * 60 * 1000; // 1 hour

export const submitVerificationRequest = onCall(
  { enforceAppCheck: true },
  async (request: CallableRequest) => {
    const { email, idImageBase64, role } = request.data || {};

    const normalizedRole = ['student', 'creator'].includes(role) ? role : 'student';

    const normalizedEmail = email?.toLowerCase()?.trim();
    if (!normalizedEmail || !/^[^@]+@[^@]+\.[^@]+$/.test(normalizedEmail)) {
      throw new HttpsError('invalid-argument', 'Valid email required');
    }

    await checkEmailAndClientRateLimits(request, 'submit_verification', normalizedEmail);

    // Reject approved school emails — they should use normal signup
    if (isAllowedStudentEmail(normalizedEmail)) {
      throw new HttpsError('invalid-argument', 'Please use the regular signup with your school email');
    }

    const idImage = parseVerificationImage(idImageBase64, 'ID');

    const otpDoc = await getOtpRef(normalizedEmail).get();
    const otpData = otpDoc.data() || {};
    if (
      !otpDoc.exists ||
      otpData.purpose !== 'verification' ||
      otpData.verified !== true ||
      otpData.expiresAt?.toMillis?.() < Date.now()
    ) {
      throw new HttpsError('permission-denied', 'A valid verified email code is required');
    }

    // Rate limit: max submissions per time window
    const cutoff = new Date(Date.now() - VERIFICATION_RATE_LIMIT_MS);
    const recentSubmissions = await db
      .collection('verification_requests')
      .where('email', '==', normalizedEmail)
      .where('submittedAt', '>=', cutoff)
      .limit(VERIFICATION_MAX_SUBMISSIONS)
      .get();

    if (recentSubmissions.size >= VERIFICATION_MAX_SUBMISSIONS) {
      throw new HttpsError(
        'resource-exhausted',
        'Too many verification requests. Please try again later.'
      );
    }

    // Check no existing student account
    const existingStudent = await db
      .collection('students')
      .where('email', '==', normalizedEmail)
      .limit(1)
      .get();

    if (!existingStudent.empty) {
      throw new HttpsError('already-exists', 'An account with this email already exists');
    }

    // Create Firestore doc first to get requestId
    const requestRef = db.collection('verification_requests').doc(hashDocId(`verification:${normalizedEmail}`));
    const requestId = requestRef.id;
    const statusToken = secureToken();

    // Upload images to Firebase Storage
    const bucket = getStorageBucket();
    const uploadId = hashDocId(statusToken).slice(0, 16);
    const idImagePath = `verification_requests/${requestId}/${uploadId}.${idImage.extension}`;
    const uploadedFile = bucket.file(idImagePath);

    try {
      await uploadedFile.save(idImage.buffer, { metadata: { contentType: idImage.contentType } });

      await db.runTransaction(async (tx) => {
        const existingRequest = await tx.get(requestRef);

        if (existingRequest.exists) {
          const existingStatus = existingRequest.data()?.status;
          if (existingStatus === 'pending') {
            throw new HttpsError('already-exists', 'You already have a pending verification request');
          }
          if (existingStatus === 'approved' || existingStatus === 'approving') {
            throw new HttpsError('failed-precondition', 'This verification request is already approved');
          }
        }

        tx.set(requestRef, {
          email: normalizedEmail,
          status: 'pending',
          role: normalizedRole,
          statusTokenHash: hashToken(statusToken),
          idImagePath,
          submittedAt: admin.firestore.FieldValue.serverTimestamp(),
          expiresAt: admin.firestore.Timestamp.fromMillis(Date.now() + 30 * 24 * 60 * 60 * 1000),
          reviewedAt: null,
          reviewedBy: null,
          rejectionReason: null,
          authUid: null,
        });
      });
    } catch (error) {
      await uploadedFile.delete({ ignoreNotFound: true }).catch(() => undefined);
      throw error;
    }

    return { success: true, requestId, statusToken };
  }
);

export const checkVerificationStatus = onCall(
  { enforceAppCheck: true },
  async (request: CallableRequest) => {
    const email = request.data?.email?.toLowerCase()?.trim();
    const statusToken = typeof request.data?.statusToken === 'string' ? request.data.statusToken : '';

    if (!email || !statusToken) {
      throw new HttpsError('invalid-argument', 'Email and status token are required');
    }

    const requestDoc = await db
      .collection('verification_requests')
      .doc(hashDocId(`verification:${email}`))
      .get();

    const data = requestDoc.data() || {};
    if (!requestDoc.exists || !secureTokenMatches(statusToken, data.statusTokenHash)) {
      throw new HttpsError('permission-denied', 'Invalid verification status token');
    }

    return {
      status: data.status,
      requestId: requestDoc.id,
      rejectionReason: data.rejectionReason || null,
      role: data.role || 'student',
    };
  }
);

export const listPendingVerificationRequests = onCall(
  { enforceAppCheck: true },
  async (request: CallableRequest) => {
    if (!request.auth) {
      throw new HttpsError('unauthenticated', 'Login required');
    }

    const adminDoc = await db.collection('students').doc(request.auth.uid).get();
    if (!adminDoc.exists || adminDoc.data()?.admin !== true) {
      throw new HttpsError('permission-denied', 'Admin access required');
    }

    const requestedLimit = Number(request.data?.limit || 25);
    const pageLimit = Math.min(Math.max(Math.floor(requestedLimit), 1), 50);
    const cursorMillis = Number(request.data?.cursorMillis || 0);
    let pendingQuery = db
      .collection('verification_requests')
      .where('status', '==', 'pending')
      .orderBy('submittedAt', 'asc')
      .limit(pageLimit);

    if (Number.isFinite(cursorMillis) && cursorMillis > 0) {
      pendingQuery = pendingQuery.startAfter(admin.firestore.Timestamp.fromMillis(cursorMillis));
    }

    const snapshot = await pendingQuery.get();

    const bucket = getStorageBucket();
    const requests = await Promise.all(snapshot.docs.map(async (doc) => {
      const data = doc.data();

      // Generate signed download URLs (valid for 1 hour)
      const [idImageUrl] = await bucket.file(data.idImagePath).getSignedUrl({
        action: 'read',
        expires: Date.now() + 60 * 60 * 1000,
      });

      return {
        requestId: doc.id,
        email: data.email,
        submittedAt: data.submittedAt,
        idImageUrl,
      };
    }));

    const nextCursorMillis = snapshot.size === pageLimit
      ? snapshot.docs[snapshot.docs.length - 1]?.data()?.submittedAt?.toMillis?.() || null
      : null;
    return { requests, nextCursorMillis };
  }
);

export const reviewVerificationRequest = onCall(
  { enforceAppCheck: true },
  async (request: CallableRequest) => {
    if (!request.auth) {
      throw new HttpsError('unauthenticated', 'Login required');
    }

    const adminDoc = await db.collection('students').doc(request.auth.uid).get();
    if (!adminDoc.exists || adminDoc.data()?.admin !== true) {
      throw new HttpsError('permission-denied', 'Admin access required');
    }

    const { requestId, action, rejectionReason } = request.data || {};

    if (!requestId || !['approve', 'reject'].includes(action)) {
      throw new HttpsError('invalid-argument', 'requestId and action (approve/reject) required');
    }

    const requestRef = db.collection('verification_requests').doc(requestId);

    if (action === 'approve') {
      const requestData = await db.runTransaction(async (tx) => {
        const requestDoc = await tx.get(requestRef);
        if (!requestDoc.exists) {
          throw new HttpsError('not-found', 'Verification request not found');
        }
        if (requestDoc.data()?.status !== 'pending') {
          throw new HttpsError('failed-precondition', 'Request already reviewed');
        }
        tx.update(requestRef, {
          status: 'approving',
          reviewedBy: request.auth?.uid,
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        });
        return requestDoc.data() || {};
      });

      try {
        let uid: string;
        try {
          const existingUser = await admin.auth().getUserByEmail(requestData.email);
          uid = existingUser.uid;
        } catch {
          const newUser = await admin.auth().createUser({
            email: requestData.email,
            emailVerified: true,
          });
          uid = newUser.uid;
        }

        await requestRef.update({
          status: 'approved',
          reviewedAt: admin.firestore.FieldValue.serverTimestamp(),
          reviewedBy: request.auth.uid,
          authUid: uid,
        });
      } catch (error) {
        await requestRef.update({
          status: 'pending',
          reviewedBy: null,
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        });
        throw error;
      }
    } else {
      await db.runTransaction(async (tx) => {
        const requestDoc = await tx.get(requestRef);
        if (!requestDoc.exists) {
          throw new HttpsError('not-found', 'Verification request not found');
        }
        if (requestDoc.data()?.status !== 'pending') {
          throw new HttpsError('failed-precondition', 'Request already reviewed');
        }
        tx.update(requestRef, {
          status: 'rejected',
          reviewedAt: admin.firestore.FieldValue.serverTimestamp(),
          reviewedBy: request.auth?.uid,
          rejectionReason: typeof rejectionReason === 'string' ? rejectionReason.trim().slice(0, 500) : null,
        });
      });
    }

    return { success: true };
  }
);
