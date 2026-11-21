/** Pure clockwise board movement shared by the Node server and browser. */
export function calculateMovement(startPos, steps, tileCount) {
  if (!Number.isInteger(tileCount) || tileCount < 1 ||
      !Number.isInteger(startPos) || startPos < 0 || startPos >= tileCount ||
      !Number.isInteger(steps) || steps < 0) {
    throw new RangeError('Movement requires a valid start position, non-negative steps, and board size.');
  }
  const absoluteDestination = startPos + steps;
  return {
    startPos,
    endPos: absoluteDestination % tileCount,
    steps,
    passedStart: Math.floor(absoluteDestination / tileCount) > 0
  };
}
