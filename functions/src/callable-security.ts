import {CallableRequest, HttpsError} from "firebase-functions/v2/https";

/* eslint-disable require-jsdoc */

export function requireAdmin(request: CallableRequest) {
  if (!request.auth) {
    throw new HttpsError("unauthenticated", "User not authenticated");
  }
  if (request.auth.token.admin !== true) {
    throw new HttpsError("permission-denied", "Admin access required");
  }
  return request.auth.uid;
}

export function requireAuthUid(request: CallableRequest) {
  if (!request.auth) {
    throw new HttpsError("unauthenticated", "User not authenticated");
  }
  return request.auth.uid;
}

export function parseRequiredString(
  value: unknown,
  field: string,
  maxLength = 200,
) {
  if (
    typeof value !== "string" ||
    value.trim().length === 0 ||
    value.trim().length > maxLength
  ) {
    throw new HttpsError(
      "invalid-argument",
      `${field} must be a non-empty string up to ${maxLength} characters`,
    );
  }
  return value.trim();
}

export function parseOptionalString(
  value: unknown,
  field: string,
  maxLength = 200,
) {
  if (value === undefined || value === null || value === "") {
    return undefined;
  }
  if (typeof value !== "string" || value.trim().length > maxLength) {
    throw new HttpsError(
      "invalid-argument",
      `${field} must be a string up to ${maxLength} characters`,
    );
  }
  return value.trim();
}
