import {clientGameStore} from '../state/ClientGameStore.js';
import {jailModalManager} from './JailModalManager.js';
import {socketClient} from '../network/SocketClient.js';
import {toast} from './hud.js';

function actionId() {
  return globalThis.crypto?.randomUUID?.() || `jail_${Date.now()}_${Math.random().toString(36).slice(2)}`;
}

export function initMultiplayerJail({client = socketClient, store = clientGameStore, modal = jailModalManager,
  getActiveRoom, getLocalPlayerId}) {
  let shownKey = null;
  const closeIfOpen = () => { if (modal.isOpen()) modal.close(); };
  const reconcile = () => {
    const state = store.getState();
    const room = getActiveRoom?.();
    if (store.diceAnimation && !store.diceAnimation.complete) return;
    const active = state.getActivePlayer();
    if (room?.status !== 'started' || state.phase !== 'WAITING_ROLL' ||
        !(active?.status === 'IN_JAIL' || active?.inJail === true)) {
      shownKey = null;
      closeIfOpen();
      return;
    }
    const key = `${room.roomCode}:${state.turnId}:${active.playerId}`;
    if (shownKey === key) return;
    shownKey = key;
    const canAct = active.playerId === getLocalPlayerId?.();
    if (!canAct) {
      closeIfOpen();
      return;
    }
    modal.promptJailAction(active, {canAct, onAction: async action => {
      if (!canAct || !client.isConnected()) {
        toast('Tindakan hanya dapat dilakukan pemain yang sedang mendapat giliran.');
        return false;
      }
      const id = actionId();
      const event = action === 'TRY_DOUBLE' ? 'game:roll-dice' : 'game:jail-action';
      const payload = action === 'TRY_DOUBLE'
        ? {turnId: state.turnId, actionId: id}
        : {turnId: state.turnId, actionId: id, action};
      const response = await client.request(event, payload);
      if (!response.ok) {
        toast(response.error?.message || 'Aksi penjara gagal.');
        return false;
      }
      modal.close();
      return true;
    }});
  };
  const unsubscribe = store.subscribe(reconcile);
  reconcile();
  return () => { unsubscribe(); closeIfOpen(); };
}
