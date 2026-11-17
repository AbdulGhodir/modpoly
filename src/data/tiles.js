import tilesCsv from './tiles.csv?raw';
import kotaCsv from './kota.csv?raw';
import transportasiCsv from './transportasi.csv?raw';
import perusahaanCsv from './perusahaan.csv?raw';

function parseCsv(raw){
 const lines = raw.trim().split(/\r?\n/);
 const headers = lines[0].split(',').map(h=>h.trim());
 return lines.slice(1).filter(l=>l.trim()).map(line=>{
  const vals = line.split(',').map(v=>v.trim());
  const row = {};
  headers.forEach((h,i)=>{
   const v = vals[i] ?? '';
   row[h] = (v !== '' && !isNaN(v)) ? Number(v) : v;
  });
  return row;
 });
}

export const KOTA_DATA = parseCsv(kotaCsv);
export const TRANSPORT_DATA = parseCsv(transportasiCsv);
export const UTIL_DATA = parseCsv(perusahaanCsv);
export const TILES_CONFIG = parseCsv(tilesCsv);

export const TILES = TILES_CONFIG.map(tile=>{
 const t = { ...tile };
 if(t.type === 'prop'){
  const kota = KOTA_DATA.find(k=>k.pos === t.pos);
  if(kota) Object.assign(t, kota);
 }else if(t.type === 'rail'){
  const trans = TRANSPORT_DATA.find(tr=>tr.pos === t.pos);
  if(trans) Object.assign(t, trans);
 }else if(t.type === 'util'){
  const util = UTIL_DATA.find(u=>u.pos === t.pos);
  if(util) Object.assign(t, util);
 }
 return t;
});
