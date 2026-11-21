import {createBoardCatalog} from './boardCatalog.js';
import tilesCsv from './tiles.csv?raw';
import kotaCsv from './kota.csv?raw';
import transportasiCsv from './transportasi.csv?raw';
import perusahaanCsv from './perusahaan.csv?raw';

const catalog = createBoardCatalog({tilesCsv, kotaCsv, transportasiCsv, perusahaanCsv});

export const {KOTA_DATA, TRANSPORT_DATA, UTIL_DATA, TILES_CONFIG, TILES} = catalog;
