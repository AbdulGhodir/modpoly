import Phaser from 'phaser';
import {CFG,VIEW} from '../config.js';
import {measureViewport,safeInsets} from '../ui/viewport.js';
import {PLAYERS, GAME, gameState, PlayerStatus} from '../data/players.js';
import {TILES} from '../data/tiles.js';
import {renderBoard} from '../board/renderer.js';
import {GEO, getPawnCoord, getTileOuterEdge, getTileCenter, projPt} from '../board/geometry.js';
import {makeToken} from '../objects/Token.js';
import {buildHud, toast, showMoneyPopup} from '../ui/hud.js';
import {turnManager, TurnPhase} from '../logic/TurnManager.js';
import {economyManager, TransactionType} from '../logic/EconomyManager.js';
import {propertyManager} from '../logic/PropertyManager.js';

export class GameScene extends Phaser.Scene{
 create(){
  // Texture papan dirender pada resolusi yang cocok dengan ukuran tampil x DPR (bukan fixed Q=2)
  this.zoom=1;
  this.computeLayout();
  this.drawBoardTex(this.wantQ());
  this.boardImg=this.add.image(0,0,'board').setOrigin(0).setScale(CFG.BW/this.boardTex.width,CFG.BH/this.boardTex.height);
  this.world=this.add.container(0,0,[this.boardImg]);
  this.tokens=PLAYERS.map((p,i)=>makeToken(this,p,i));
  this.hintGroup=this.add.container(0,0);
  this.pinLayer=this.add.container(0,0);
  this.landingMarker=null;

  this.world.add(this.tokens);
  this.world.add(this.pinLayer);
  this.world.add(this.hintGroup);
  this.scale.on('resize',()=>this.fit());
  this.fit();
  this.setupView();

  this.drawOwnershipPins();
  this.showStepHints();

  this._onDiceRolling=()=>this.hideStepHints();
  window.addEventListener('dice:rolling',this._onDiceRolling);

  this._onTurnReady=()=>this.showStepHints();
  window.addEventListener('turn:ready',this._onTurnReady);

  // Tampilkan step hints kembali saat giliran masih milik pemain yang sama (setelah double)
  this._onTurnAction=(e)=>{
    const {allowExtraRoll}=e.detail||{};
    if(allowExtraRoll){
      this.showStepHints();
    } else {
      this.hideStepHints();
    }
  };
  window.addEventListener('turn:action',this._onTurnAction);

  this._onDiceRolled=async(e)=>{
   const {total}=e.detail;

   // Hitung tujuan akhir dan tampilkan landing marker yang mantul atas-bawah
   const player=gameState.getActivePlayer();
   const destination=(player.pos+total)%TILES.length;
   this.showLandingMarker(destination);

   // Satu detik setelah dadu berhenti dan dapat nilainya, baru mulai jalan
   await new Promise(r=>setTimeout(r,1000));

   const pIdx=gameState.currentTurn;
   const token=this.tokens[pIdx];
   const originTile=player.pos;

   for(let step=1;step<=total;step++){
    player.pos=(player.pos+1)%TILES.length;

    if(step===1) this.adjustTile(originTile, pIdx);

    if(player.pos===0){
     economyManager.addMoney(player.id, 200, 'Bonus melewati Start: +$200', TransactionType.SALARY);
     showMoneyPopup(pIdx, 200);
     buildHud();
    }

    const isFinalStep=(step===total);
    if(!isFinalStep){
     await token.hopTo(player.pos, 0, 1);
     await new Promise(r=>setTimeout(r,10));
    }else{
     const onFinal=PLAYERS.map((pl,i)=>({pl,i})).filter(item=>item.pl.pos===player.pos);
     const finalTotal=onFinal.length;
     const mySlot=onFinal.findIndex(item=>item.i===pIdx);
     onFinal.forEach((item,s)=>{
      if(item.i!==pIdx){
       const [ox,oy]=getPawnCoord(player.pos,s,finalTotal);
       this.tokens[item.i].slideTo(ox,oy);
      }
     });
     await token.hopTo(player.pos, mySlot, finalTotal);
    }
   }

   // Pion sudah sampai — hilangkan landing marker
   this.hideLandingMarker();

   await new Promise(r=>setTimeout(r,450));
   await turnManager.resolveTile(player.pos);
   if(gameState.gameStatus==='FINISHED') return;
   await new Promise(r=>setTimeout(r,400));
   if (player.status === PlayerStatus.BANKRUPT) {
     turnManager.endTurn();
   } else {
     turnManager.startPlayerAction();
   }
  };

  window.addEventListener('dice:rolled',this._onDiceRolled);

  // Re-render papan ketika ada properti yang dibeli / dilelang / diubah kepemilikannya
  this._onBuyProp=(e)=>{
   if(e.detail?.type==='BUY_PROP') setTimeout(()=>this.refreshBoard(),30);
  };
  window.addEventListener('economy:transaction',this._onBuyProp);
  this._onAuctionEnd=()=>setTimeout(()=>this.refreshBoard(),30);
  window.addEventListener('auction:ended',this._onAuctionEnd);
  this._onPropUpdated=()=>setTimeout(()=>this.refreshBoard(),30);
  window.addEventListener('property:updated',this._onPropUpdated);

  // Penanganan visual saat pemain masuk Penjara (langsung lompat ke petak 10)
  this._onPlayerJailed=(e)=>{
   const {playerId}=e.detail;
   const pIdx=gameState.players.findIndex(p=>p.id===Number(playerId));
   if(pIdx!==-1){
    this.tokens[pIdx].hopTo(10, 0, 1);
   }
  };
  window.addEventListener('player:jailed',this._onPlayerJailed);

  // Sembunyikan pion pemain yang bangkrut dari papan
  this._onPlayerBankrupt=(e)=>{
    const {debtor}=e.detail||{};
    if(!debtor) return;
    const pIdx=gameState.players.findIndex(p=>p.id===Number(debtor.id));
    if(pIdx!==-1 && this.tokens[pIdx]){
      // Fade out pion lalu sembunyikan
      this.tweens.add({
        targets:this.tokens[pIdx],
        alpha:0,
        scaleX:0,
        scaleY:0,
        duration:600,
        ease:'Back.easeIn',
        onComplete:()=>{
          this.tokens[pIdx].setVisible(false);
        }
      });
    }
  };
  window.addEventListener('player:bankrupt',this._onPlayerBankrupt);

  // ─── HANDLER: Animasi Pergerakan dari Kartu Kesempatan / Parkir Bebas Travel ──
  this._onAnimateMove=async(e)=>{
   const {playerId, targetPos, clockwise=true, awardStartBonus=false, resolveTile=false, skipRoll=false, onComplete} = e.detail || {};
   const pIdx = gameState.players.findIndex(p=>p.id===Number(playerId));
   if(pIdx===-1) {
     if(typeof onComplete === 'function') onComplete();
     return;
   }

   // Cegah animasi ganda untuk pemain yang sedang bergerak
   if(this.movingPawnId === playerId){
     if(typeof onComplete === 'function') onComplete();
     return;
   }

   this.movingPawnId = playerId;
   turnManager.setPhase(TurnPhase.MOVING);

   try {
     const player = gameState.players[pIdx];
     const token = this.tokens[pIdx];
     const startPos = player.pos;

     // Hitung jumlah langkah
     let steps;
     if(clockwise){
      steps = (targetPos - startPos + 40) % 40;
      if(steps === 0) steps = 40;
     } else {
      steps = e.detail.steps || ((startPos - targetPos + 40) % 40);
     }

     // Animasi langkah per langkah
     for(let step=1; step<=steps; step++){
      if(clockwise){
       player.pos = (player.pos + 1) % 40;
      } else {
       player.pos = (player.pos - 1 + 40) % 40;
      }

      if(step===1) this.adjustTile(startPos, pIdx);

      // Bonus $200 saat melewati START (hanya clockwise)
      if(awardStartBonus && player.pos===0 && clockwise){
       economyManager.addMoney(player.id, 200, 'Bonus melewati Start: +$200', TransactionType.SALARY);
       showMoneyPopup(pIdx, 200);
       buildHud();
      }

      const isFinal = (step===steps);
      if(!isFinal){
       await token.hopTo(player.pos, 0, 1);
       await new Promise(r=>setTimeout(r,10));
      } else {
       const onFinal = PLAYERS.map((pl,i)=>({pl,i})).filter(item=>item.pl.pos===player.pos);
       const finalTotal = onFinal.length;
       const mySlot = onFinal.findIndex(item=>item.i===pIdx);
       onFinal.forEach((item,s)=>{
        if(item.i!==pIdx){
         const [ox,oy]=getPawnCoord(player.pos,s,finalTotal);
         this.tokens[item.i].slideTo(ox,oy);
        }
       });
       await token.hopTo(player.pos, mySlot, finalTotal);
      }
     }

     await new Promise(r=>setTimeout(r,450));

     // Resolve petak tujuan jika diminta
     if(resolveTile){
      await turnManager.resolveTile(player.pos);
      if(gameState.gameStatus==='FINISHED') return;
      await new Promise(r=>setTimeout(r,400));
      if(skipRoll){
       // Parkir Bebas travel: langsung akhiri giliran tanpa lempar dadu
       turnManager.endTurn();
      }
     }
   } catch(err) {
     console.error('Error during pawn move animation:', err);
   } finally {
     this.movingPawnId = null;
     if(typeof onComplete === 'function') {
       onComplete();
     }
   }
  };
  window.addEventListener('player:animate_move',this._onAnimateMove);

  this.events.once('shutdown',()=>{
   window.removeEventListener('dice:rolled',this._onDiceRolled);
   window.removeEventListener('dice:rolling',this._onDiceRolling);
   window.removeEventListener('turn:ready',this._onTurnReady);
   window.removeEventListener('turn:action',this._onTurnAction);
   window.removeEventListener('economy:transaction',this._onBuyProp);
   window.removeEventListener('auction:ended',this._onAuctionEnd);
   window.removeEventListener('property:updated',this._onPropUpdated);
   window.removeEventListener('player:jailed',this._onPlayerJailed);
   window.removeEventListener('player:bankrupt',this._onPlayerBankrupt);
   window.removeEventListener('player:animate_move',this._onAnimateMove);
  });
 }

 // ─── REFRESH BOARD TEXTURE ──────────────────────────────────────────────────
 refreshBoard(){
  if(!this.boardTex) return;
  const ctx=this.boardTex.getContext();
  ctx.setTransform(1,0,0,1,0,0);
  ctx.clearRect(0,0,ctx.canvas.width,ctx.canvas.height);
  renderBoard(ctx,this.curQ);
  this.boardTex.refresh();
  this.drawOwnershipPins();
 }

 // ─── LANDING MARKER: pin lokasi bouncing di petak tujuan ────────────────────
 showLandingMarker(tileIdx){
  this.hideLandingMarker();
  const [cx,cy]=getTileCenter(tileIdx);

  const container=this.add.container(cx, cy-18);

  const shadow=this.add.graphics();
  shadow.fillStyle(0x000000,0.18);
  shadow.fillEllipse(0,20,18,6);
  container.add(shadow);

  const pin=this.add.graphics();
  // Badan pin merah: lingkaran + ekor runcing
  pin.fillStyle(0xff2d2d,1);
  pin.fillCircle(0,-4,9);
  pin.fillTriangle(-6,2, 6,2, 0,16);
  // Lubang tengah putih (mata pin)
  pin.fillStyle(0xffffff,0.95);
  pin.fillCircle(0,-4,4);
  // Outline tipis
  pin.lineStyle(1.2, 0xaa0000, 0.7);
  pin.strokeCircle(0,-4,9);
  container.add(pin);

  this.tweens.add({
   targets:container,
   y:cy-28,
   duration:420,
   ease:'Sine.easeInOut',
   yoyo:true,
   repeat:-1
  });

  this.world.add(container);
  this.landingMarker=container;
 }

 hideLandingMarker(){
  if(this.landingMarker){
   const marker=this.landingMarker;
   this.landingMarker=null;
   this.tweens.killTweensOf(marker);
   this.tweens.add({
    targets:marker,
    alpha:0,
    scaleX:0,
    scaleY:0,
    duration:200,
    ease:'Back.easeIn',
    onComplete:()=>marker.destroy()
   });
  }
 }

 // ─── STEP HINTS ─────────────────────────────────────────────────────────────
 showStepHints(){
  this.hintGroup.removeAll(true);
  this.hintGroup.setAlpha(1);
  const player=gameState.getActivePlayer();
  if(!player)return;
  const currentPos=player.pos;

  for(let step=1;step<=12;step++){
   const targetPos=(currentPos+step)%TILES.length;
   const [hx,hy]=getTileOuterEdge(targetPos,26);

   const numTxt=this.add.text(hx,hy,String(step),{
    fontFamily:'system-ui, -apple-system, "Segoe UI", Arial, sans-serif',
    fontSize:'24px',
    fontWeight:'800',
    color:'#000000',
    resolution:3
   }).setOrigin(0.5);

   numTxt.setDepth(hy+20);
   numTxt.setScale(0);
   numTxt.setAlpha(0);

   this.tweens.add({
    targets:numTxt,
    scale:1,
    alpha:1,
    duration:220,
    delay:(step-1)*22,
    ease:'Back.easeOut'
   });

   this.hintGroup.add(numTxt);
  }
 }

 hideStepHints(){
  this.tweens.add({
   targets:this.hintGroup,
   alpha:0,
   duration:180,
   ease:'Quad.easeOut',
   onComplete:()=>{
    this.hintGroup.removeAll(true);
    this.hintGroup.setAlpha(1);
   }
  });
 }

 adjustTile(tileIdx, excludePlayerIdx=-1){
  const onTile=PLAYERS.map((pl,i)=>({pl,i})).filter(item=>item.pl.pos===tileIdx && item.i!==excludePlayerIdx);
  const total=onTile.length;
  onTile.forEach((item,slot)=>{
   const [tx,ty]=getPawnCoord(tileIdx,slot,total);
   this.tokens[item.i].slideTo(tx,ty);
  });
 }

 // ─── VIEWPORT, SKALA, RESOLUSI TEXTURE, ZOOM ────────────────────────────────
 // Semua ukuran "css" = piksel CSS; ukuran dunia Phaser = css x DPR (canvas beresolusi fisik).
 computeLayout(){
  const vp=measureViewport(),ins=safeInsets();
  const d=(this.scale&&this.scale.width?this.scale.width/vp.w:0)||vp.d;
  const phone=vp.phoneLandscape;
  // HP landscape: papan memakai hampir seluruh layar (HUD ringkas menempati sudut kosong diamond).
  // Desktop/tablet/portrait: sama seperti sebelumnya (sisakan 56px di atas).
  const vb=phone?VIEW.phone:{x:0,y:0,w:CFG.BW,h:CFG.BH};
  const box=phone?{l:ins.l+2,t:2,w:vp.w-ins.l-ins.r-4,h:vp.h-4}:{l:0,t:56,w:vp.w,h:vp.h-56};
  const fit=Math.min(box.w/vb.w,box.h/vb.h)*(phone?1:.98); // rasio papan tetap (skala seragam)
  this.lay={vp,d,vb,box,fit,zMax:1};
  this.lay.zMax=Math.max(1,Math.min(VIEW.maxZoom,this.qMax()*1.15/(fit*d)));
 }
 qMax(){return Math.floor(Math.min(3,VIEW.maxTex/CFG.BW,Math.sqrt(1.1e7/(CFG.BW*CFG.BH)))*4)/4}
 // Q = piksel texture per unit dunia, dibuat TEPAT ≈ piksel layar per unit (1:1) → tulisan tajam tanpa resampling
 wantQ(){const L=this.lay;return Math.max(.5,Math.min(Math.round(L.fit*this.zoom*L.d*100)/100,this.qMax()))}

 drawBoardTex(Q){
  const {BW,BH}=CFG,tw=Math.round(BW*Q),th=Math.round(BH*Q);
  this.curQ=Q;
  if(!this.boardTex) this.boardTex=this.textures.createCanvas('board',tw,th);
  else this.boardTex.setSize(tw,th);
  const ctx=this.boardTex.getContext();
  ctx.setTransform(1,0,0,1,0,0);
  ctx.clearRect(0,0,tw,th);
  renderBoard(ctx,Q);
  this.boardTex.refresh();
  this.boardTex.setFilter(Phaser.Textures.FilterMode.LINEAR);
  if(this.boardImg){this.boardImg.setSizeToFrame();this.boardImg.setScale(BW/tw,BH/th);}
 }

 // Render ulang texture hanya jika kebutuhan resolusi berubah (debounce, bukan tiap resize)
 queueRerender(){
  clearTimeout(this._qt);
  const stale=()=>Math.abs(this.wantQ()-this.curQ)>this.curQ*.01; // abaikan selisih <1%
  if(!stale()) return;
  this._qt=setTimeout(()=>{if(stale())this.drawBoardTex(this.wantQ())},180);
 }

 fit(){
  this.computeLayout();
  this.zoom=1; // resize/rotasi → kembali ke tampilan penuh
  const {box,vb,fit}=this.lay;
  this.pos={x:box.l+(box.w-vb.w*fit)/2-vb.x*fit,y:box.t+(box.h-vb.h*fit)/2-vb.y*fit};
  this.applyView();
 }

 clampPos(){
  const {box,vb,fit}=this.lay,S=fit*this.zoom,p=this.pos;
  const cl=(v,b0,bl,v0,vl)=>vl*S<=bl?b0+(bl-vl*S)/2-v0*S:Math.min(b0-v0*S,Math.max(b0+bl-(v0+vl)*S,v));
  p.x=cl(p.x,box.l,box.w,vb.x,vb.w);
  p.y=cl(p.y,box.t,box.h,vb.y,vb.h);
 }

 applyView(){
  this.clampPos();
  const {d,fit}=this.lay;
  this.world.setScale(fit*this.zoom*d).setPosition(Math.round(this.pos.x*d),Math.round(this.pos.y*d));
  // Klaster UI tengah (putaran/logo/dadu) mengikuti pusat & skala papan (dipakai CSS mode HP)
  const S=fit*this.zoom,rs=document.documentElement.style;
  rs.setProperty('--cx',(this.pos.x+CFG.OX*S).toFixed(1)+'px');
  rs.setProperty('--cy',(this.pos.y+(CFG.OY+CFG.L*CFG.B-CFG.Z0)*S).toFixed(1)+'px');
  rs.setProperty('--cs',Math.max(.5,Math.min(1,S/.348)).toFixed(3));
  this.queueRerender();
 }

 zoomAt(cx,cy,z){
  const L=this.lay;
  z=Math.max(1,Math.min(L.zMax,z));
  const S0=L.fit*this.zoom,S1=L.fit*z;
  this.pos.x=cx-(cx-this.pos.x)/S0*S1;
  this.pos.y=cy-(cy-this.pos.y)/S0*S1;
  this.zoom=z;
  this.applyView();
 }

 // Zoom opsional agar tulisan petak terbaca di layar kecil: cubit 2 jari / scroll / ketuk 2x; geser saat zoom
 setupView(){
  const inp=this.input;
  inp.addPointer(1);
  let pinch=null,drag=null,lastTap=0,tx=0,ty=0;
  const css=p=>({x:p.x/this.lay.d,y:p.y/this.lay.d});
  const down=()=>[inp.pointer1,inp.pointer2].filter(q=>q&&q.isDown);
  inp.on('pointerdown',p=>{
   const t=down(),c=css(p);
   if(t.length>=2){
    const a=css(t[0]),b=css(t[1]);
    pinch={dist:Math.hypot(a.x-b.x,a.y-b.y)||1,z:this.zoom};drag=null;return;
   }
   drag={x:c.x,y:c.y,px:this.pos.x,py:this.pos.y};
   const now=performance.now();
   if(now-lastTap<300&&Math.hypot(c.x-tx,c.y-ty)<30){
    this.zoomAt(c.x,c.y,this.zoom>1.05?1:Math.min(2.4,this.lay.zMax));lastTap=0;
   }else{lastTap=now;tx=c.x;ty=c.y;}
  });
  inp.on('pointermove',p=>{
   const t=down();
   if(t.length>=2&&pinch){
    const a=css(t[0]),b=css(t[1]);
    this.zoomAt((a.x+b.x)/2,(a.y+b.y)/2,pinch.z*(Math.hypot(a.x-b.x,a.y-b.y)/pinch.dist));
   }else if(drag&&p.isDown&&this.zoom>1){
    const c=css(p);
    this.pos.x=drag.px+(c.x-drag.x);this.pos.y=drag.py+(c.y-drag.y);
    this.applyView();
   }
  });
  inp.on('pointerup',()=>{if(down().length<2)pinch=null;if(down().length===0)drag=null});
  inp.on('wheel',(p,o,dx,dy)=>{const c=css(p);this.zoomAt(c.x,c.y,this.zoom*(dy<0?1.15:1/1.15))});
 }

 // ─── OWNERSHIP PINS: 3D UPRIGHT PUSH PINS ────────────────────────────────────
 drawOwnershipPins(){
  this.pinLayer.removeAll(true);
  const props=propertyManager.getAllProperties().filter(p=>p.owner);
  props.forEach(prop=>{
   const g=GEO[prop.pos];
   if(!g) return;
   const owner=gameState.getPlayerById(prop.owner);
   if(!owner) return;

   const colorInt=parseInt((owner.color||'#ffffff').replace('#',''),16);

   // Pojok kanan atas color bar
   const lx = g.w/2 - 7;
   const ly = -g.h/2 + 7;
   const rot = g.rot*Math.PI/180;
   const rx = lx*Math.cos(rot) - ly*Math.sin(rot);
   const ry = lx*Math.sin(rot) + ly*Math.cos(rot);
   const [sx,sy]=projPt(g.cx+rx, g.cy+ry, CFG.Z0+CFG.TH);

   const gr=this.add.graphics();
   // 1. Bayangan elips di atas papan
   gr.fillStyle(0x000000, 0.28);
   gr.fillEllipse(sx+1, sy+1, 8, 4);

   // 2. Jarum metal perak 3D tegak runcing ke bawah
   gr.fillStyle(0x475569, 1);
   gr.fillTriangle(sx-1.5, sy-8, sx+1.5, sy-8, sx, sy);

   // 3. Kepala bulat 3D berwarna sesuai pemilik
   gr.fillStyle(colorInt, 1);
   gr.fillCircle(sx, sy-14, 7);

   // 4. Kilau glossy 3D
   gr.fillStyle(0xffffff, 0.7);
   gr.fillCircle(sx-2.2, sy-16.2, 2.3);

   // 5. Outline tipis mempertegas bentuk bulat 3D
   gr.lineStyle(1.2, 0x00000055, 0.5);
   gr.strokeCircle(sx, sy-14, 7);

   this.pinLayer.add(gr);
  });
 }
}
