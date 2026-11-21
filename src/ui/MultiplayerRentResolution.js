export function initMultiplayerRentResolution({store, modalManager, eventTarget = globalThis.window}) {
  const seen = new Set();
  const updatePending = () => {
    if (!store.presentation.rentPending) return;
    store.presentation.rentPending = false;
    store.notify({type: 'rent-presentation-complete'});
  };
  const unsubscribe = store.subscribe(({change}) => {
    if (change.type === 'rent-resolved') {
      const resolutionId = change.detail?.resolutionId;
      if (!resolutionId || seen.has(resolutionId)) return;
      seen.add(resolutionId);
      // The authoritative debt modal handles insufficient funds. Successful rent is automatic.
      updatePending();
    }
  });
  return () => {
    unsubscribe();
  };
}
