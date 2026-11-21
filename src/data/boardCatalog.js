function parseCsv(raw) {
  const lines = raw.trim().split(/\r?\n/);
  const headers = lines[0].split(',').map(header => header.trim());
  return lines.slice(1).filter(line => line.trim()).map(line => {
    const values = line.split(',').map(value => value.trim());
    const row = {};
    headers.forEach((header, index) => {
      const value = values[index] ?? '';
      row[header] = value !== '' && !isNaN(value) ? Number(value) : value;
    });
    return row;
  });
}

export function createBoardCatalog({tilesCsv, kotaCsv, transportasiCsv, perusahaanCsv}) {
  const KOTA_DATA = parseCsv(kotaCsv);
  const TRANSPORT_DATA = parseCsv(transportasiCsv);
  const UTIL_DATA = parseCsv(perusahaanCsv);
  const TILES_CONFIG = parseCsv(tilesCsv);

  const TILES = TILES_CONFIG.map(tile => {
    const result = {...tile};
    if (result.type === 'prop') {
      const city = KOTA_DATA.find(item => item.pos === result.pos);
      if (city) Object.assign(result, city);
    } else if (result.type === 'rail') {
      const rail = TRANSPORT_DATA.find(item => item.pos === result.pos);
      if (rail) Object.assign(result, rail);
    } else if (result.type === 'util') {
      const utility = UTIL_DATA.find(item => item.pos === result.pos);
      if (utility) Object.assign(result, utility);
    }
    return result;
  });

  return {KOTA_DATA, TRANSPORT_DATA, UTIL_DATA, TILES_CONFIG, TILES};
}
