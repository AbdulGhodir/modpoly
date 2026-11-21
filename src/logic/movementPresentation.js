/** Serialize movement presentation after the official dice animation and its follow-up pause. */
export async function playMovementAfterDice({turnId, waitForDiceAnimation, onDiceAnimationComplete, delay, animate}) {
  await waitForDiceAnimation(turnId);
  onDiceAnimationComplete?.();
  await delay(1000);
  return animate();
}
