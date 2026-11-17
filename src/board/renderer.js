import {CFG,COL} from '../config.js';
import {TILES} from '../data/tiles.js';
import {GEO} from './geometry.js';
import {propertyManager} from '../logic/PropertyManager.js';
import {gameState} from '../logic/GameState.js';

function sh(hex,f){
 const n=parseInt(hex.slice(1),16),c=[n>>16,n>>8&255,n&255].map(v=>Math.round(f<0?v*(1+f):v+(255-v)*f));
 return`rgb(${c})`;
}

function hexToRgba(hex,a){
 const n=parseInt(hex.slice(1),16);
 return`rgba(${n>>16},${(n>>8)&255},${n&255},${a})`;
}

function roundRect(X,x,y,w,h,r){
 X.beginPath();
 if(typeof X.roundRect==='function'){
  X.roundRect(x,y,w,h,r);
 }else{
  X.moveTo(x+r,y);
  X.lineTo(x+w-r,y);
  X.quadraticCurveTo(x+w,y,x+w,y+r);
  X.lineTo(x+w,y+h-r);
  X.quadraticCurveTo(x+w,y+h,x+w-r,y+h);
  X.lineTo(x+r,y+h);
  X.quadraticCurveTo(x,y+h,x,y+h-r);
  X.lineTo(x,y+r);
  X.quadraticCurveTo(x,y,x+r,y);
  X.closePath();
 }
}

function getContrastColor(hex){
 if(!hex) return '#ffffff';
 const c=hex.replace('#','');
 const r=parseInt(c.substr(0,2),16)||0;
 const g=parseInt(c.substr(2,2),16)||0;
 const b=parseInt(c.substr(4,2),16)||0;
 const yiq=(r*299+g*587+b*114)/1000;
 return yiq>=155?'#18181b':'#ffffff';
}

function drawRentBadge(X,w,h,rentVal,ownerColor,txtFn,isMortgaged=false,buildingText=''){
 const badgeW=w-8;
 const badgeH=17;
 const badgeX=4;
 const badgeY=h-19;
 const badgeR=4;

 roundRect(X,badgeX,badgeY,badgeW,badgeH,badgeR);
 X.fillStyle=isMortgaged ? '#991b1b' : ownerColor;
 X.fill();
 X.lineWidth=1;
 X.strokeStyle='rgba(0,0,0,0.25)';
 X.stroke();

 const rentText=isMortgaged ? 'TERGADAI' : (buildingText ? `${buildingText} $${rentVal}` : `$${rentVal}`);
 const textColor=isMortgaged ? '#ffffff' : getContrastColor(ownerColor);
 const fontSize=isMortgaged ? 9.5 : (buildingText ? 9.5 : 12.5);
 txtFn(rentText,w/2,badgeY+badgeH/2+0.5,badgeW-4,fontSize,textColor,800);
}

export function renderBoard(X,qOverride){
 const {A,B,OX,OY,L,D,Z0,TH}=CFG;
 const Q=qOverride||CFG.Q; // resolusi texture mengikuti ukuran tampil x DPR (lihat GameScene)
 const proj=(u,v,z)=>[(u-v)*A+OX,(u+v)*B+OY-z];
 const S=()=>{
  X.setTransform(Q,0,0,Q,0,0);
  X.imageSmoothingEnabled=true;
  X.imageSmoothingQuality='high';
 };
 const poly=(p,f,s)=>{
  S();X.beginPath();
  p.forEach((q,i)=>i?X.lineTo(q[0],q[1]):X.moveTo(q[0],q[1]));
  X.closePath();
  if(f){X.fillStyle=f;X.fill()}
  if(s){X.strokeStyle=s;X.lineWidth=1.2;X.stroke()}
 };
 const box=(u,v,w,d,z,h,c)=>{
  const t=z+h;
  poly([proj(u+w,v,t),proj(u+w,v+d,t),proj(u+w,v+d,z),proj(u+w,v,z)],sh(c,-.32));
  poly([proj(u,v+d,t),proj(u+w,v+d,t),proj(u+w,v+d,z),proj(u,v+d,z)],sh(c,-.14));
  poly([proj(u,v,t),proj(u+w,v,t),proj(u+w,v+d,t),proj(u,v+d,t)],sh(c,.18));
 };
 const roof=(u,v,w,d,z,h,c)=>{
  u-=2;v-=2;w+=4;d+=4;const a=proj(u+w/2,v+d/2,z+h);
  poly([proj(u+w,v,z),proj(u+w,v+d,z),a],sh(c,-.3));
  poly([proj(u,v+d,z),proj(u+w,v+d,z),a],sh(c,-.05));
 };
 const tf=(g,z)=>{
  S();X.transform(A,B,-A,B,OX,OY-z);
  X.translate(g.cx,g.cy);
  X.rotate(g.rot*Math.PI/180);
  X.translate(-g.w/2,-g.h/2);
 };
 const FONT_SANS='system-ui, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif';
 const txt=(s,x,y,max,size,color,wt=600)=>{
  let z=size;
  if(wt>=700&&s.length<=5) wt-=100; // huruf sedikit → lebih tipis (tidak terlalu bold)
  if('textRendering' in X) X.textRendering='geometricPrecision';
  if('fontKerning' in X) X.fontKerning='normal';
  if('letterSpacing' in X) X.letterSpacing=s.length>3&&s===s.toUpperCase()?'0.25px':'0px';
  for(;z>8;z-=.5){
   X.font=`${wt} ${z}px ${FONT_SANS}`;
   if(X.measureText(s).width<=max)break;
  }
  X.textAlign='center';
  X.textBaseline='middle';
  X.fillStyle=color;
  X.fillText(s,x,y);
 };

 // ===== Bangunan 3D kecil (rumah & hotel) — mengikuti arah petak, di antara nama kota dan harga =====
 const drawBuildings=(g,zt,nHouse,hotel,ownerColor)=>{
  const rad=g.rot*Math.PI/180,co=Math.cos(rad),si=Math.sin(rad);
  const lw=(lx,ly)=>[g.cx+(lx-g.w/2)*co-(ly-g.h/2)*si,g.cy+(lx-g.w/2)*si+(ly-g.h/2)*co];
  const lp=(lx,ly,z)=>{const q=lw(lx,ly);return proj(q[0],q[1],zt+z)};
  // arah "naik" bangunan di layar, dinyatakan dalam koordinat lokal petak (agar tidak menutup teks)
  const det=2*A*B,ra=(-si-co)*A/det,rb=-((co-si)*A)/det;
  const n=hotel?1:Math.min(4,nHouse);
  if(n<=0) return;
  const hwid=hotel?20:9,dpt=hotel?11:8,gap=2,zm=hotel?15:10;
  const rowW=n*hwid+(n-1)*gap;
  const yTop=54,yBot=g.h-21,zoneH=Math.max(10,yBot-yTop);
  let s=Math.min(1,(g.w-12)/(rowW+Math.abs(ra*zm)),zoneH/(dpt+Math.abs(rb*zm)));
  s=Math.max(.3,s);
  const rax=ra*zm*s,rby=rb*zm*s;
  const fx=g.w/2-(rowW*s+Math.abs(rax))/2-Math.min(0,rax);
  const fy=(yTop+yBot)/2-(dpt*s+Math.abs(rby))/2-Math.min(0,rby);
  const EDGE='rgba(0,0,0,.22)';

  const edgesOf=(x,y,wd,dp)=>{
   const cs=[[x,y],[x+wd,y],[x+wd,y+dp],[x,y+dp]],nm=[[0,-1],[1,0],[0,1],[-1,0]];
   return cs.map((a,i)=>{
    const b=cs[(i+1)%4],nx=nm[i][0],ny=nm[i][1];
    const nu=nx*co-ny*si,nv=nx*si+ny*co;
    return{a,b,nu,nv,vis:nu+nv>1e-6};
   });
  };
  const prism=(x,y,wd,dp,z0,ht,c)=>{
   const E=edgesOf(x,y,wd,dp);
   E.forEach(e=>{
    if(!e.vis) return;
    poly([lp(e.a[0],e.a[1],z0),lp(e.b[0],e.b[1],z0),lp(e.b[0],e.b[1],z0+ht),lp(e.a[0],e.a[1],z0+ht)],
         sh(c,-.23-.09*(e.nu-e.nv)),EDGE);
   });
   poly(E.map(e=>lp(e.a[0],e.a[1],z0+ht)),sh(c,.18),EDGE);
   return E;
  };
  const pyramid=(x,y,wd,dp,z0,rh,c,ov)=>{
   const E=edgesOf(x-ov,y-ov,wd+2*ov,dp+2*ov),apex=lp(x+wd/2,y+dp/2,z0+rh);
   E.forEach(e=>{
    if(!e.vis) return;
    poly([lp(e.a[0],e.a[1],z0),lp(e.b[0],e.b[1],z0),apex],sh(c,-.12-.12*(e.nu-e.nv)),EDGE);
   });
  };
  const shadow=(x,y,wd,dp)=>{
   const m=1.2*s;
   poly(edgesOf(x-m,y-m,wd+2*m,dp+2*m).map(e=>lp(e.a[0],e.a[1],0)),'rgba(60,35,10,.18)');
  };

  if(hotel){
   const wd=hwid*s,dp=dpt*s,ht=12*s;
   const hotelColor=ownerColor||'#64748b';
   shadow(fx,fy,wd,dp);
   const E=prism(fx,fy,wd,dp,0,ht,hotelColor);
   // jendela hotel (2 baris x 3 kolom) di sisi yang terlihat
   E.forEach(e=>{
    if(!e.vis) return;
    const P=(t,z)=>lp(e.a[0]+(e.b[0]-e.a[0])*t,e.a[1]+(e.b[1]-e.a[1])*t,z);
    [[.2,.38],[.55,.73]].forEach(r=>[.2,.5,.8].forEach(t=>{
     const t0=t-.07,t1=t+.07;
     poly([P(t0,ht*r[0]),P(t1,ht*r[0]),P(t1,ht*r[1]),P(t0,ht*r[1])],'#fde68a');
    }));
   });
   // mahkota di atap
   prism(fx+(wd-8*s)/2,fy+(dp-5*s)/2,8*s,5*s,ht,3*s,sh(hotelColor,-.28));
   return;
  }

  const order=[...Array(n).keys()].sort((p,q)=>{
   const cp=lw(fx+(p*(hwid+gap)+hwid/2)*s,fy+dpt*s/2),cq=lw(fx+(q*(hwid+gap)+hwid/2)*s,fy+dpt*s/2);
   return (cp[0]+cp[1])-(cq[0]+cq[1]);
  });
  order.forEach(i=>{
   const x=fx+i*(hwid+gap)*s,wd=hwid*s,dp=dpt*s,wall=5.5*s;
   shadow(x,fy,wd,dp);
   const houseColor=ownerColor||'#64748b';
   prism(x,fy,wd,dp,0,wall,houseColor);
   pyramid(x,fy,wd,dp,wall,4.5*s,houseColor,1*s);
  });
 };

 // Bayangan + slab papan utama
 S();X.save();
 X.shadowColor='rgba(50,25,5,.35)';
 X.shadowBlur=60*Q;
 X.shadowOffsetY=30*Q;
 poly([proj(0,0,0),proj(L,0,0),proj(L,L,0),proj(0,L,0)],'#6a4022');
 X.restore();
 poly([proj(L,0,Z0),proj(L,L,Z0),proj(L,L,0),proj(L,0,0)],'#7f4e2b');
 poly([proj(0,L,Z0),proj(L,L,Z0),proj(L,L,0),proj(0,L,0)],'#a26737');
 poly([proj(0,0,Z0),proj(L,0,Z0),proj(L,L,Z0),proj(0,L,Z0)],'#f7f4eb','#dfd5c4');

 // Area tengah papan: Warna cream lembut & hangat (tidak tabrakan dengan dadu putih)
 tf({cx:L/2,cy:L/2,w:L,h:L,rot:0},Z0);
 const gr=X.createRadialGradient(L/2,L/2,0,L/2,L/2,260);
 gr.addColorStop(0,'#faf5eb');  // cream hangat terang di tengah
 gr.addColorStop(1,'#ecdcc6');  // cream pasir lembut di pinggiran
 X.fillStyle=gr;
 X.fillRect(D+6,D+6,L-2*D-12,L-2*D-12);
 X.strokeStyle='#d6c3a8';
 X.lineWidth=2.5;
 X.strokeRect(D+6,D+6,L-2*D-12,L-2*D-12);

 // Render setiap petak (urut belakang → depan berdasarkan isometrik)
 [...TILES.keys()].sort((a,b)=>GEO[a].cx+GEO[a].cy-GEO[b].cx-GEO[b].cy).forEach(i=>{
  const t=TILES[i],g=GEO[i],u0=g.cx-g.bw/2,v0=g.cy-g.bh/2,u1=u0+g.bw,v1=v0+g.bh,zt=Z0+TH;
  const base=t.type==='corner'?(t.color||'#8d99ae'):'#fbf9f4';
  poly([proj(u1,v0,zt),proj(u1,v1,zt),proj(u1,v1,Z0),proj(u1,v0,Z0)],sh(base,-.32));
  poly([proj(u0,v1,zt),proj(u1,v1,zt),proj(u1,v1,Z0),proj(u0,v1,Z0)],sh(base,-.18));
  tf(g,zt);
  const w=g.w,h=g.h;
  let bHouses=0,bHotel=false,bOwner=null;
  let prop=null;

  if(t.type==='corner'){
   const cg=X.createLinearGradient(0,0,w,h);
   cg.addColorStop(0,sh(t.color||'#8d99ae',.35));
   cg.addColorStop(1,t.color||'#8d99ae');
   X.fillStyle=cg;
   X.fillRect(0,0,w,h);
   txt(t.icon||'★',w/2,h*.32,50,28,'#fff');
   txt(t.nama||'',w/2,h*.62,w-6,13.5,'#fff',700);
   txt(t.sub||'',w/2,h*.8,w-6,10.5,'rgba(255,255,255,.95)',600);
  }else{
   X.fillStyle='#fdfcf8';
   X.fillRect(0,0,w,h);

   try{
    if(propertyManager?.getProperty){
     prop=propertyManager.getProperty(t.pos);
     if(prop?.owner && gameState?.getPlayerById){
      bOwner=gameState.getPlayerById(prop.owner);
     }
    }
   }catch(e){}

   if(t.type==='prop'){
    const c=COL[t.group]||'#888';

    // 1. Kotak warna solid di bagian atas petak kota (sesuai foto kartu kota)
    X.fillStyle=c;
    X.fillRect(0,0,w,23);

    // Garis pemisah halus
    X.fillStyle='rgba(0,0,0,.1)';
    X.fillRect(0,22,w,1);

    // 2. Gradasi warna yang memudar ke bawah (sesuai foto referensi kartu kota)
    const fade=X.createLinearGradient(0,23,0,h);
    fade.addColorStop(0,hexToRgba(c,0.32));
    fade.addColorStop(0.5,hexToRgba(c,0.12));
    fade.addColorStop(1,hexToRgba(c,0.02));
    X.fillStyle=fade;
    X.fillRect(0,23,w,h-23);

    // Teks nama kota (huruf kapital tebal tajam) & harga / sewa
    txt(t.nama.toUpperCase(),w/2,46,w-6,11.5,'#18181b',700);

    bHouses=prop?.houses||0;
    bHotel=!!prop?.hasHotel;

    // Badge sewa jika sudah dibeli
    if(bOwner){
     let rentVal=propertyManager.calculateRent(t.pos);
     if(!rentVal && !prop?.isMortgaged) rentVal=prop?.rent?.base||t.price||0;
     drawRentBadge(X, w, h, rentVal, bOwner.color, txt, prop?.isMortgaged);
    }else{
     txt('$'+t.price,w/2,h-9,w-6,12,'#15803d',700);
    }
   }else if(t.type==='chance'){
    X.fillStyle='#9b6bf2';
    X.fillRect(0,0,w,16);
    txt('CHANCE',w/2,8.5,w-4,9,'#fff',600);
    txt('?',w/2,h*.52,36,36,'#7c3aed',700);
   }else if(t.type==='tax'){
    X.fillStyle='#ef5350';
    X.fillRect(0,0,w,16);
    txt('PAJAK',w/2,8.5,w-4,9,'#fff',600);
    txt('💸',w/2,h*.46,36,22);
    txt('-$'+t.price,w/2,h-8,w-4,12,'#b91c1c',700);
   }else if(t.type==='rail'){
    X.fillStyle='#334155';
    X.fillRect(0,0,w,16);
    txt('STASIUN',w/2,8.5,w-4,8.5,'#fff',600);
    txt('🚆',w/2,h*.42,36,20);
    txt(t.nama.replace('Stasiun ',''),w/2,h*.68,w-4,10,'#1e293b',600);
    if(bOwner){
     let rentVal=propertyManager.calculateRent(t.pos);
     if(!rentVal && !prop?.isMortgaged) rentVal=prop?.rent?.count1||25;
     drawRentBadge(X, w, h, rentVal, bOwner.color, txt, prop?.isMortgaged);
    }else{
     txt('$'+t.price,w/2,h-8,w-4,12,'#15803d',700);
    }
   }else if(t.type==='util'){
    X.fillStyle='#0284c7';
    X.fillRect(0,0,w,16);
    txt('UTILITAS',w/2,8.5,w-4,8.5,'#fff',600);
    txt(t.icon||'⚡',w/2,h*.44,36,20);
    txt(t.nama.includes('Listrik')?'PLN':'PDAM',w/2,h*.68,w-4,10.5,'#0369a1',700);
    if(bOwner){
     let rentVal=propertyManager.calculateRent(t.pos);
     if(!rentVal && !prop?.isMortgaged) rentVal=28;
     drawRentBadge(X, w, h, rentVal, bOwner.color, txt, prop?.isMortgaged);
    }else{
     txt('$'+t.price,w/2,h-8,w-4,12,'#15803d',700);
    }
   }
  }

  const hl=X.createLinearGradient(0,0,0,h);
  hl.addColorStop(0,'rgba(255,255,255,.32)');
  hl.addColorStop(.5,'rgba(255,255,255,0)');
  X.fillStyle=hl;
  X.fillRect(0,0,w,h);
  X.strokeStyle='rgba(130,95,55,.55)';
  X.lineWidth=1.2;
  X.strokeRect(0,0,w,h);

  // Bangunan 3D digambar terakhir (setelah transform petak tidak dipakai lagi)
  if(bHouses>0||bHotel) drawBuildings(g,zt,bHouses,bHotel,bOwner?.color);
 });

 // Reset transform setelah selesai render agar context bersih sempurna
 X.setTransform(1,0,0,1,0,0);
 if('letterSpacing' in X) X.letterSpacing='0px';
}
