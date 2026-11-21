/**
 * Shared "pick a tile on the board" mode (used by Free Parking travel).
 *
 * Kept as plain module state — not tied to Phaser or the DOM — so the prompt logic can start a pick
 * before the scene exists (e.g. a reconnecting tab) and the scene can render whatever is active
 * the moment it subscribes.
 */
const listeners = new Set();
let active = null;
let sequence = 0;

export function getActiveTilePick() { return active; }

/** Starts a pick, replacing any previous one. `disabled` tiles are shown dark and ignore taps. */
export function startTilePick({disabled = [], onPick} = {}) {
  if (typeof onPick !== 'function') throw new TypeError('startTilePick needs an onPick callback');
  active = {id: ++sequence, disabled: [...disabled], onPick};
  listeners.forEach(listener => listener(active));
  return active;
}

/** Ends the pick. When a request is given, only that exact request is ended (stale calls are ignored). */
export function endTilePick(request = null) {
  if (!active || (request && request.id !== active.id)) return false;
  active = null;
  listeners.forEach(listener => listener(null));
  return true;
}

/** Subscribes to changes; the listener is called immediately with the current request (or null). */
export function subscribeTilePick(listener) {
  listeners.add(listener);
  listener(active);
  return () => listeners.delete(listener);
}

/** Forwards a tapped tile to the active pick. Returns true only when the tile was a valid choice. */
export function pickTile(pos) {
  const request = active;
  if (!request || !Number.isInteger(pos) || pos < 0 || request.disabled.includes(pos)) return false;
  request.onPick(pos);
  return true;
}

export function pointInPolygon(x, y, points) {
  let inside = false;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    const [xi, yi] = points[i], [xj, yj] = points[j];
    if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** Index of the polygon containing the point, or -1. */
export function findTileAt(x, y, polygons) {
  return polygons.findIndex(points => pointInPolygon(x, y, points));
}
