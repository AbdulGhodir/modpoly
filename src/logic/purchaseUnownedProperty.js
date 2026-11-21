import {TransactionType} from './EconomyManager.js';

export function purchaseUnownedProperty({ state, economy, properties, pos, playerId }) {
  const prop = properties.getProperty(pos);
  const player = state.getPlayerById(playerId);
  if (!prop) return { success: false, reason: 'Properti tidak ditemukan.' };
  if (!player) return { success: false, reason: 'Pemain tidak ditemukan.' };
  if (prop.owner !== null) return { success: false, reason: 'Properti sudah dimiliki.' };

  const paid = economy.deductMoney(
    playerId,
    prop.price,
    `Membeli properti ${prop.name} seharga $${prop.price}`,
    TransactionType.BUY_PROP
  );
  if (!paid) return { success: false, reason: 'Saldo tidak cukup untuk membeli properti.' };

  properties.setOwner(pos, playerId);
  return { success: true, property: prop, player };
}
