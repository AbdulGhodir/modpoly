export const isPlainObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
export const hasOnlyKeys = (value, allowedKeys) => isPlainObject(value) &&
  Object.keys(value).every(key => allowedKeys.includes(key));
export const isValidIdentifier = value => typeof value === 'string' &&
  /^[A-Za-z0-9][A-Za-z0-9:_-]{0,127}$/.test(value);
export const isValidTurnId = value => Number.isSafeInteger(value) && value >= 1;
export const isValidBoardPosition = value => Number.isInteger(value) && value >= 0 && value < 40;
