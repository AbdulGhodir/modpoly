import {clientGameStore} from '../state/ClientGameStore.js';
import {animateRentTransfer, showMoneyPopup} from './hud.js';
import {initMoneyTransactionTracker} from '../network/MoneyTransactionTracker.js';
import {getAnimatedBalanceChanges, MovementMoneyPresentation} from '../network/MovementMoneyPresentation.js';

export function initMultiplayerMoneyAnimation({store = clientGameStore, getActiveRoom = () => null,
  onBalanceChange} = {}) {
  const defaultPresentBalanceChange = ({changes, transactions = []}) => {
    for (const {playerId, delta} of getAnimatedBalanceChanges(changes, transactions, store.getPlayers())) {
      const playerIndex = store.getPlayerIndex(playerId);
      if (playerIndex !== -1) showMoneyPopup(playerIndex, delta);
    }
    const rent = transactions.find(transaction => transaction.type === 'RENT');
    const payer = changes.find(item => item.delta < 0), receiver = changes.find(item => item.delta > 0);
    if (rent && payer && receiver) animateRentTransfer(payer.playerId, receiver.playerId, rent.amount);
  };
  const presentBalanceChange = onBalanceChange || defaultPresentBalanceChange;
  const movementPresentation = new MovementMoneyPresentation({store, present: presentBalanceChange});
  const tracker = initMoneyTransactionTracker({store,
    isMultiplayer: () => getActiveRoom()?.status === 'started',
    onBalanceChange: payload => movementPresentation.handleBalanceChange(payload)});
  const unsubscribePresentation = store.subscribe(({change}) => movementPresentation.handleStoreChange(change));
  return {destroy() {unsubscribePresentation(); tracker.destroy(); movementPresentation.clear();}};
}
