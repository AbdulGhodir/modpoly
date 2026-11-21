import {clientGameStore} from '../state/ClientGameStore.js';

function createActionId() {
  return globalThis.crypto?.randomUUID?.() || `parking_${Date.now()}_${Math.random().toString(36).slice(2)}`;
}

export function initMultiplayerFreeParking({client, store = clientGameStore, modal, getActiveRoom, getLocalPlayerId,
  notify = () => {}}) {
  if (!client || !modal) throw new TypeError('Multiplayer Free Parking needs a client and modal manager.');
  let shownKey = null;
  const closeIfOpen = () => {
    if (!modal.isOpen()) return;
    if (typeof modal.cancelTravelPrompt === 'function') modal.cancelTravelPrompt();
    else modal.close();
  };
  const reconcile = () => {
    const room = getActiveRoom?.();
    const state = store.getState();
    const player = state.getActivePlayer();
    const pending = store.pendingFreeParkingDecision;
    if (room?.status !== 'started' || state.phase !== 'WAITING_ROLL' || !pending ||
        pending.playerId !== player?.playerId || pending.turnId !== state.turnId || player?.pos !== 20) {
      shownKey = null;
      closeIfOpen();
      return;
    }
    const key = `${room.roomCode}:${state.turnId}:${player.playerId}`;
    if (shownKey === key) return;
    shownKey = key;
    const canAct = player.playerId === getLocalPlayerId?.();
    if (!canAct) {
      closeIfOpen();
      return;
    }
    modal.promptTravel(player, {canAct, onAction: async (action, targetPos) => {
      if (!canAct || !client.isConnected()) {
        notify('Hanya pemain yang sedang mendapat giliran yang dapat memilih Travel.');
        return false;
      }
      const payload = {turnId: state.turnId, actionId: createActionId(), action,
        ...(action === 'TRAVEL' ? {targetPos} : {})};
      const response = await client.request('game:free-parking-action', payload);
      if (!response.ok) {
        notify(response.error?.message || 'Pilihan Parkir Bebas gagal diproses.');
        return false;
      }
      return true;
    }});
  };
  const unsubscribe = store.subscribe(reconcile);
  reconcile();
  return () => { unsubscribe(); closeIfOpen(); };
}
