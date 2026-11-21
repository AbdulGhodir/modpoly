/** Shared Monopoly rent calculation used by single-player and authoritative multiplayer. */
export function calculatePropertyRent(property, properties, diceRoll = 7) {
  if (!property || !property.owner || property.isMortgaged) return 0;
  const all = properties instanceof Map ? [...properties.values()] : Array.isArray(properties) ? properties : [];

  if (property.type === 'prop') {
    if (property.hasHotel) return property.rent.hotel;
    if (property.houses === 4) return property.rent.house4;
    if (property.houses === 3) return property.rent.house3;
    if (property.houses === 2) return property.rent.house2;
    if (property.houses === 1) return property.rent.house1;
    const groupProperties = all.filter(item => item.type === 'prop' && item.group === property.group);
    const isMonopoly = groupProperties.length > 0 && groupProperties.every(item => item.owner === property.owner);
    return isMonopoly ? property.rent.base * 2 : property.rent.base;
  }

  if (property.type === 'rail') {
    const count = all.filter(item => item.type === 'rail' && item.owner === property.owner).length;
    return property.rent[`count${Math.min(4, Math.max(1, count))}`] || 25;
  }

  if (property.type === 'util') {
    const count = all.filter(item => item.type === 'util' && item.owner === property.owner).length;
    return diceRoll * (count >= 2 ? property.rent.factor2 : property.rent.factor1);
  }
  return 0;
}
