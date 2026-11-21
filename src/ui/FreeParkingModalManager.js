import {createActionGuard} from '../logic/ActionGuard.js';
import {startTilePick, endTilePick} from '../board/tilePick.js';

export const PARKING_TRAVEL_COST = 50;
export const PARKING_TILE_POS = 20;
const INSUFFICIENT_FUNDS_MESSAGE = 'Uang Anda tidak cukup untuk parkir bebas.';

// Same #toast element as hud.js; duplicated here to avoid an import cycle (hud -> ... -> TurnManager -> this).
let toastTimer = null;
function showToast(message) {
  if (typeof document === 'undefined') return;
  const element = document.getElementById('toast');
  if (!element) return;
  element.textContent = message;
  element.classList.add('s');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => element.classList.remove('s'), 3000);
}

/**
 * Free Parking travel prompt. Instead of a modal, the player taps a tile on the board (glowing tiles
 * are valid, the Free Parking tile itself is dark) while a hint in the middle of the board offers
 * "no travel". Resolves with {action: 'TRAVEL', targetPos} | {action: 'STAY'} | {action: 'CANCELLED'}.
 */
export class FreeParkingModalManager {
  constructor() {
    this.panel = null;
    this.active = false;
    this.pickRequest = null;
    this.pendingTravelResolve = null;
    this._pick = null;
    this._skip = null;
    if (typeof window !== 'undefined') {
      window.addEventListener('game:over', () => this.cancelTravelPrompt());
    }
  }

  isOpen() {
    return this.active;
  }

  close() {
    this.active = false;
    this._pick = null;
    this._skip = null;
    if (this.pickRequest) endTilePick(this.pickRequest);
    this.pickRequest = null;
    this.panel?.remove();
    this.panel = null;
    if (typeof document !== 'undefined') document.body?.classList.remove('parking-picking');
  }

  cancelTravelPrompt() {
    const resolve = this.pendingTravelResolve;
    this.close();
    resolve?.({action: 'CANCELLED'});
  }

  /** Called by the "no travel" button. */
  skip() { return this._skip ? this._skip() : undefined; }

  /** Called when a board tile is chosen (the board already ignores the Free Parking tile). */
  pick(pos) { return this._pick ? this._pick(pos) : undefined; }

  _showPanel({broke, onSkip}) {
    if (typeof document === 'undefined' || !document.body) return;
    this.panel?.remove();
    const panel = document.createElement('div');
    panel.id = 'parking-pick-panel';
    panel.className = `parking-pick-panel${broke ? ' broke' : ''}`;
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-live', 'polite');
    panel.innerHTML = broke
      ? `<div class="pp-title">🅿️ Parkir Bebas</div>
         <div class="pp-hint">Uang Anda tidak cukup (butuh $${PARKING_TRAVEL_COST}).</div>
         <button type="button" class="pp-skip">🎲 Lanjut Kocok Dadu</button>`
      : `<div class="pp-title">🅿️ Pilih tempat parkir</div>
         <div class="pp-cost">Bayar $${PARKING_TRAVEL_COST}</div>
         <div class="pp-hint">Ketuk petak yang menyala di papan</div>
         <button type="button" class="pp-skip">🎲 Tidak Memilih (Kocok Dadu)</button>`;
    panel.querySelector('.pp-skip').addEventListener('click', onSkip);
    document.body.appendChild(panel);
    document.body.classList.add('parking-picking');
    this.panel = panel;
  }

  promptTravel(player, options = {}) {
    return new Promise(resolve => {
      if (this.pendingTravelResolve) this.cancelTravelPrompt();
      let settled = false;
      const finish = result => {
        if (settled) return;
        settled = true;
        if (this.pendingTravelResolve === finish) this.pendingTravelResolve = null;
        resolve(result);
      };
      this.pendingTravelResolve = finish;

      const multiplayer = typeof options.onAction === 'function';
      const canAct = !multiplayer || options.canAct === true;
      const notify = typeof options.notify === 'function' ? options.notify : showToast;
      if (!canAct) { finish({action: 'CANCELLED'}); return; }

      // Multiplayer: the server must accept the choice before the prompt closes (false = rejected).
      const send = (action, targetPos) => multiplayer
        ? Promise.resolve(options.onAction(action, targetPos)).then(ok => ok !== false)
        : Promise.resolve(true);
      const stay = async () => {
        if (!await send('STAY')) return false;
        this.close();
        finish({action: 'STAY'});
        return true;
      };
      const travel = async targetPos => {
        if (!await send('TRAVEL', targetPos)) return false;
        this.close();
        finish({action: 'TRAVEL', targetPos, cost: PARKING_TRAVEL_COST, willPassStart: targetPos < PARKING_TILE_POS});
        return true;
      };

      let busy = false; // a TRAVEL request is in flight; ignore further taps / "no travel" meanwhile
      this.active = true;
      this._skip = createActionGuard(() => busy ? false : stay());

      if (!(Number(player?.money) >= PARKING_TRAVEL_COST)) {
        // Cannot afford it: tell the player and carry on to a normal dice roll. If the server rejects
        // the automatic STAY (e.g. connection hiccup), offer a retry button instead of getting stuck.
        notify(INSUFFICIENT_FUNDS_MESSAGE);
        stay().then(ok => {
          if (!ok && !settled) this._showPanel({broke: true, onSkip: () => this.skip()});
        });
        return;
      }

      this._pick = targetPos => {
        if (busy || targetPos === PARKING_TILE_POS) return undefined;
        busy = true;
        return travel(targetPos).finally(() => { busy = false; });
      };
      this.pickRequest = startTilePick({disabled: [PARKING_TILE_POS], onPick: pos => this.pick(pos)});
      this._showPanel({broke: false, onSkip: () => this.skip()});
    });
  }
}

export const freeParkingModalManager = new FreeParkingModalManager();
