/* eslint-disable require-jsdoc */

export const HARD_MAXIMUM_BYTES_BILLED = 64 * 1024 * 1024;

export function resolveMaximumBytesBilled(
  ...configuredValues: Array<string | undefined>
) {
  const configuredValue = configuredValues.find((value) => value);
  const configured = Number(configuredValue);

  return Number.isSafeInteger(configured) && configured > 0 ?
    Math.min(configured, HARD_MAXIMUM_BYTES_BILLED) :
    HARD_MAXIMUM_BYTES_BILLED;
}
