export const MAX_TRACKED_ONLINE_CLICKS_PER_DAY = 100;

export const normalizeOnlineClickRequestId = (value: unknown) => {
  if (typeof value !== 'string') return null;
  const requestId = value.trim();
  return /^[A-Za-z0-9_-]{16,128}$/.test(requestId) ? requestId : null;
};

export const normalizeHttpsPurchaseUrl = (value: unknown) => {
  if (typeof value !== 'string') return null;
  try {
    const parsed = new URL(value.trim());
    if (parsed.protocol !== 'https:' || !parsed.hostname || parsed.username || parsed.password) return null;
    return parsed.toString();
  } catch {
    return null;
  }
};

export const shouldTrackOnlineClick = (count: unknown) => {
  const numericCount = Number(count);
  return Number.isFinite(numericCount) && numericCount >= 0 && numericCount < MAX_TRACKED_ONLINE_CLICKS_PER_DAY;
};
