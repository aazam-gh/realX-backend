/* eslint-disable max-len */
export const BADRGO_PILOT_CAMPAIGN_ID = "badrgo-first-ride-2026";
export const BADRGO_PILOT_TOTAL_CODES = 100;
export const BADRGO_PILOT_PUBLIC_LIMIT = 80;
export const BADRGO_PILOT_RESERVED_LIMIT = 20;

export type PilotCampaignStatus = "draft" | "active" | "paused" | "ended";
export type EffectivePilotCampaignStatus =
  | PilotCampaignStatus
  | "scheduled"
  | "sold_out";

export const normalizePilotCodes = (value: unknown): string[] => {
  if (!Array.isArray(value)) {
    throw new Error("Codes must be provided as an array");
  }

  const codes = value.map((candidate) =>
    typeof candidate === "string" ? candidate.trim().toUpperCase() : ""
  );

  if (codes.length !== BADRGO_PILOT_TOTAL_CODES) {
    throw new Error(`Exactly ${BADRGO_PILOT_TOTAL_CODES} codes are required`);
  }
  if (codes.some((code) => !/^[A-Z0-9]{6,32}$/.test(code))) {
    throw new Error("Every code must contain 6-32 uppercase letters or numbers");
  }
  if (new Set(codes).size !== codes.length) {
    throw new Error("Coupon codes must be unique");
  }

  return codes;
};

export const getPilotCodeDocumentId = (sequence: number) =>
  String(sequence).padStart(3, "0");

export const getEffectivePilotCampaignStatus = ({
  status,
  startsAtMs,
  endsAtMs,
  publicAssignedCount,
  nowMs = Date.now(),
}: {
  status: PilotCampaignStatus;
  startsAtMs?: number | null;
  endsAtMs?: number | null;
  publicAssignedCount: number;
  nowMs?: number;
}): EffectivePilotCampaignStatus => {
  if (status !== "active") return status;
  if (startsAtMs && nowMs < startsAtMs) return "scheduled";
  if (endsAtMs && nowMs >= endsAtMs) return "ended";
  if (publicAssignedCount >= BADRGO_PILOT_PUBLIC_LIMIT) return "sold_out";
  return "active";
};


