import {CFG} from '../config.js';
import {TILES} from '../data/tiles.js';

function geo(i){
 const {W,D,L}=CFG,s=Math.floor(i/10),k=i%10;
 if(k===0){
  const x=[L-D,0,0,L-D][s],y=[L-D,L-D,0,0][s];
  return{cx:x+D/2,cy:y+D/2,w:D,h:D,rot:0,bw:D,bh:D};
 }
 const o=(k-.5)*W;
 const c=[[L-D-o,L-D/2],[D/2,L-D-o],[D+o,D/2],[L-D/2,D+o]][s];
 const rot=[0,90,180,270][s],sw=s%2;
 return{cx:c[0],cy:c[1],w:W,h:D,rot,bw:sw?D:W,bh:sw?W:D}; // "atas" lokal selalu menghadap pusat papan
}
export const GEO=TILES.map((_,i)=>geo(i));

export const projPt=(u,v,z)=>[(u-v)*CFG.A+CFG.OX,(u+v)*CFG.B+CFG.OY-z];

export function getTileCenter(tileIdx){
 const g=GEO[tileIdx];
 return projPt(g.cx,g.cy,CFG.Z0+CFG.TH);
}

export function getSlotOffset(tileIdx, slotIndex, totalOnTile){
 if(totalOnTile<=1) return [0,0];
 const g=GEO[tileIdx];
 const isCorner=(tileIdx%10===0);
 const ox=isCorner?16:(g.bw>g.bh?14:9);
 const oy=isCorner?16:(g.bw>g.bh?9:14);
 if(totalOnTile===2){
  return slotIndex===0?[-ox,-oy]:[ox,oy];
 }
 if(totalOnTile===3){
  return slotIndex===0?[-ox,-oy]:(slotIndex===1?[ox,-oy]:[0,oy]);
 }
 return [[-ox,-oy],[ox,-oy],[-ox,oy],[ox,oy]][slotIndex]||[0,0];
}

export function getPawnCoord(tileIdx, slotIndex=0, totalOnTile=1){
 if(totalOnTile<=1) return getTileCenter(tileIdx);
 const g=GEO[tileIdx];
 const [ox,oy]=getSlotOffset(tileIdx, slotIndex, totalOnTile);
 return projPt(g.cx+ox,g.cy+oy,CFG.Z0+CFG.TH);
}

export function getTokenCoord(tileIdx, playerIdx){
 return getPawnCoord(tileIdx, playerIdx, 4);
}

export function getTileOuterEdge(tileIdx, offsetDist=18){
 const {L, Z0, TH}=CFG;
 const s=Math.floor(tileIdx/10);
 const k=tileIdx%10;
 const g=GEO[tileIdx];

 let u,v;
 if(k===0){
  if(s===0){u=L+offsetDist;v=L+offsetDist;}
  else if(s===1){u=-offsetDist;v=L+offsetDist;}
  else if(s===2){u=-offsetDist;v=-offsetDist;}
  else{u=L+offsetDist;v=-offsetDist;}
 }else{
  if(s===0){u=g.cx;v=L+offsetDist;}
  else if(s===1){u=-offsetDist;v=g.cy;}
  else if(s===2){u=g.cx;v=-offsetDist;}
  else{u=L+offsetDist;v=g.cy;}
 }
 return projPt(u,v,Z0+TH);
}

/** Four projected corners [[x,y]...] of a tile's top face, in board-world coordinates. */
export function getTilePolygon(tileIdx){
 const g=GEO[tileIdx],rot=g.rot*Math.PI/180,c=Math.cos(rot),s=Math.sin(rot);
 return [[-1,-1],[1,-1],[1,1],[-1,1]].map(([sx,sy])=>{
  const lx=sx*g.w/2,ly=sy*g.h/2;
  return projPt(g.cx+lx*c-ly*s,g.cy+lx*s+ly*c,CFG.Z0+CFG.TH);
 });
}
