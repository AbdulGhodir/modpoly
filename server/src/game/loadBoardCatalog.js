import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {createBoardCatalog} from '../../../src/data/boardCatalog.js';

const dataDirectory = new URL('../../../src/data/', import.meta.url);
const readCsv = name => readFileSync(fileURLToPath(new URL(name, dataDirectory)), 'utf8');
let catalog;

export function loadBoardCatalog() {
  if (!catalog) {
    catalog = createBoardCatalog({
      tilesCsv: readCsv('tiles.csv'),
      kotaCsv: readCsv('kota.csv'),
      transportasiCsv: readCsv('transportasi.csv'),
      perusahaanCsv: readCsv('perusahaan.csv')
    });
  }
  return catalog;
}
