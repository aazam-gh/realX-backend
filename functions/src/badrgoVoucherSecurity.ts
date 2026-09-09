/* eslint-disable max-len */
import {createHash} from "crypto";

export const BADRGO_VOUCHER_PROGRAM_ID = "badrgo-rides";
export const BADRGO_VOUCHER_TIME_ZONE = "Asia/Qatar";
export const BADRGO_MAX_IMPORT_CODES = 5000;

export type VoucherProgramStatus = "active" | "paused" | "ended";
export type VoucherCodeStatus =
  | "available"
  | "assigned"
  | "redeemed"
  | "expired"
  | "revoked";

export type VoucherEligibilityReason =
  | "eligible"
  | "auth_required"
  | "previous_code_not_redeemed"
  | "already_claimed_this_week"
  | "program_paused"
  | "program_ended"
  | "out_of_stock";

export const getVoucherEligibility = ({
  authenticated,
  programStatus,
  availableCount,
  currentClaimStatus,
  lastClaimPeriodKey,
  periodKey,
}: {
  authenticated: boolean;
  programStatus: VoucherProgramStatus;
  availableCount: number;
  currentClaimStatus?: string | null;
  lastClaimPeriodKey?: string | null;
  periodKey: string;
}): VoucherEligibilityReason => {
  if (!authenticated) return "auth_required";
  if (currentClaimStatus === "assigned") return "previous_code_not_redeemed";
  if (lastClaimPeriodKey === periodKey) return "already_claimed_this_week";
  if (programStatus === "ended") return "program_ended";
  if (programStatus !== "active") return "program_paused";
  if (availableCount <= 0) return "out_of_stock";
  return "eligible";
};

export const normalizeVoucherCode = (value: unknown): string => {
  if (typeof value !== "string") throw new Error("Every code must be text");
  const code = value.trim().toUpperCase();
  if (!/^[A-Z0-9_-]{6,64}$/.test(code)) {
    throw new Error("Codes must contain 6-64 letters, numbers, underscores, or hyphens");
  }
  return code;
};

export const normalizeVoucherCodes = (value: unknown): string[] => {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error("At least one code is required");
  }
  if (value.length > BADRGO_MAX_IMPORT_CODES) {
    throw new Error(`Import at most ${BADRGO_MAX_IMPORT_CODES} codes per batch`);
  }
  const codes = value.map(normalizeVoucherCode);
  if (new Set(codes).size !== codes.length) {
    throw new Error("The import contains duplicate codes");
  }
  return codes;
};

export const sha256 = (value: string) =>
  createHash("sha256").update(value).digest("hex");

export const voucherCodeDocumentId = (code: string) =>
  sha256(`${BADRGO_VOUCHER_PROGRAM_ID}:${normalizeVoucherCode(code)}`);

export const identityHash = (uid: string, email?: string | null) =>
  sha256((email?.trim().toLowerCase() || `uid:${uid}`));

export const getQatarWeekKey = (date = new Date()): string => {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: BADRGO_VOUCHER_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const value = (type: Intl.DateTimeFormatPartTypes) =>
    Number(parts.find((part) => part.type === type)?.value || 0);
  const localDate = new Date(Date.UTC(value("year"), value("month") - 1, value("day")));
  const weekday = localDate.getUTCDay() || 7;
  localDate.setUTCDate(localDate.getUTCDate() + 4 - weekday);
  const isoYear = localDate.getUTCFullYear();
  const yearStart = new Date(Date.UTC(isoYear, 0, 1));
  const week = Math.ceil((((localDate.getTime() - yearStart.getTime()) / 86400000) + 1) / 7);
  return `${isoYear}-W${String(week).padStart(2, "0")}`;
};

export const getNextQatarWeekIso = (date = new Date()): string => {
  const qatarOffsetMs = 3 * 60 * 60 * 1000;
  const qatarNow = new Date(date.getTime() + qatarOffsetMs);
  const day = qatarNow.getUTCDay() || 7;
  const daysUntilMonday = 8 - day;
  const nextMondayQatarAsUtc = Date.UTC(
    qatarNow.getUTCFullYear(),
    qatarNow.getUTCMonth(),
    qatarNow.getUTCDate() + daysUntilMonday,
    0,
    0,
    0,
    0
  );
  return new Date(nextMondayQatarAsUtc - qatarOffsetMs).toISOString();
};

export const normalizeImportId = (value: unknown): string | null => {
  if (typeof value !== "string") return null;
  const importId = value.trim();
  return /^[A-Za-z0-9_-]{8,80}$/.test(importId) ? importId : null;
};
