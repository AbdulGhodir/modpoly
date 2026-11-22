import {clientGameStore} from '../state/ClientGameStore.js';
import {modalManager} from './ModalManager.js';
import {tileModalManager} from './TileModalManager.js';
import {canShowPlayerActionMenu} from './multiplayerTurnControls.js';

let multiplayerContext = null;

export function setHudMultiplayerContext(context) {
 multiplayerContext = context;
 context?.client?.onStatusChange?.(() => buildHud());
 buildHud();
}

export function buildHud(){
 if (typeof document === 'undefined') return;
 const hudEl = document.getElementById('hud');
 if (!hudEl) return;
 const players=clientGameStore.getPlayers();
 const cur=clientGameStore.getActivePlayer() || players[clientGameStore.getCurrentTurn()];
 hudEl.innerHTML=players.map((p,i)=>{
  const isActive=(i===clientGameStore.getCurrentTurn());
  const isBankrupt=(p.status==='BANKRUPT');
  const isInJail=(p.status==='IN_JAIL'||p.inJail===true);
  const room=multiplayerContext?.getActiveRoom?.();
  const multiplayer=room?.status==='started';
  const localPlayerId=multiplayerContext?.getLocalPlayerId?.();
  const allowed=multiplayer
   ? p.playerId===localPlayerId && canShowPlayerActionMenu({state:clientGameStore.getState(),store:clientGameStore,
      room,localPlayerId,connected:multiplayerContext?.client?.isConnected?.()===true})
   : isActive && !isBankrupt && !p.isBot;
  const actionBtn=allowed ?`<button class="btn-action-trigger" id="btn-player-action" title="Buka menu tindakan pemain">📋 AKSI PEMAIN</button>`:'';
  return `
   <div class="pl p${p.id}${isActive?' on':''}${isBankrupt?' bankrupt':''}${isInJail?' in-jail':''}" style="--c:${p.color};--d:${p.dark}">
    <i class="av">${isInJail?'<span class="av-jail-icon">🔒</span>':''}</i>
    <div>
     <b>${p.name} ${isBankrupt ? '<span class="bankrupt-tag">BANGKRUT</span>' : ''}</b>
     <small>${p.cn}</small>
     <span>💰 $${clientGameStore.getDisplayedBalance(p.playerId)?.toLocaleString('id-ID') ?? p.money.toLocaleString('id-ID')}</span>
     ${actionBtn}
    </div>
    <em>${p.id}</em>
   </div>
  `;
 }).join('');

 document.getElementById('rd').textContent=clientGameStore.getRound();
 const tn=document.getElementById('tn');
 if(tn && cur){
  tn.textContent=cur.name;
  tn.style.color=cur.color;
 }

 const actionBtn=document.getElementById('btn-player-action');
 if(actionBtn){
  actionBtn.onclick=(e)=>{
   e.stopPropagation();
   const room=multiplayerContext?.getActiveRoom?.();
   if(room?.status==='started' && !canShowPlayerActionMenu({state:clientGameStore.getState(),store:clientGameStore,
    room,localPlayerId:multiplayerContext?.getLocalPlayerId?.(),connected:multiplayerContext?.client?.isConnected?.()===true})){
    buildHud();
    return;
   }
   // Cegah buka modal jika popup wajib petak (beli/lelang/sewa) sedang aktif
   if(tileModalManager.isOpen()){
    toast('Selesaikan proses petak saat ini terlebih dahulu!');
    return;
   }
   modalManager.open();
  };
 }
}

let tm;
const moneyPopupSlots = new Map();
export function toast(m){
 if (typeof document === 'undefined') return;
 const t=document.getElementById('toast');
 if(!t)return;
 t.textContent=m;
 t.classList.add('s');
 clearTimeout(tm);
 tm=setTimeout(()=>t.classList.remove('s'),3000);
}

export function showMoneyPopup(playerIdx, amount){
 if (typeof document === 'undefined') return;
 const p=clientGameStore.getPlayerAtIndex(playerIdx);
 if(!p || !amount)return;
 const plEl=document.querySelector(`.pl.p${p.id}`);
 if(!plEl)return;

 const rect=plEl.getBoundingClientRect();
 const pop=document.createElement('div');
 const isPositive=amount>=0;
 const posClass=p.id<=2?'pos-bottom':'pos-top';
 pop.className=`money-pop ${isPositive?'plus':'minus'} ${posClass}`;
 pop.textContent=(isPositive?'+$':'-$')+Math.abs(amount).toLocaleString('id-ID');
 const slots=moneyPopupSlots.get(p.id) || new Set();
 let slot=0;
 while(slots.has(slot)) slot++;
 slots.add(slot);
 moneyPopupSlots.set(p.id,slots);

 // Posisi fixed di viewport agar tidak terhapus saat HUD di-rebuild
 pop.style.left=(rect.left + rect.width / 2)+'px';
 if(p.id<=2){
  pop.style.top=(rect.bottom + 8 + slot*30)+'px';
 }else{
  pop.style.top=(rect.top - 8 - slot*30)+'px';
 }

 document.body.appendChild(pop);
 setTimeout(()=>{pop.remove();slots.delete(slot);if(!slots.size)moneyPopupSlots.delete(p.id)},1800);
}

export function animateRentTransfer(fromPlayerId, toPlayerId, amount){
 if(typeof document==='undefined' || !amount || !document.body.animate) return;
 const findPlayer=id=>clientGameStore.getPlayer(id) || clientGameStore.getPlayers().find(player=>player.id===id);
 const fromPlayer=findPlayer(fromPlayerId), toPlayer=findPlayer(toPlayerId);
 if(!fromPlayer || !toPlayer) return;
 const from=document.querySelector(`.pl.p${fromPlayer.id}`)?.getBoundingClientRect();
 const to=document.querySelector(`.pl.p${toPlayer.id}`)?.getBoundingClientRect();
 if(!from || !to) return;
 const icon=document.createElement('div');
 icon.className='rent-transfer-fly';
 icon.textContent=`💸 $${Number(amount).toLocaleString('id-ID')}`;
 const x1=from.left+from.width/2, y1=from.top+from.height/2;
 const x2=to.left+to.width/2, y2=to.top+to.height/2;
 icon.style.left=`${x1}px`; icon.style.top=`${y1}px`;
 document.body.appendChild(icon);
 const reduce=window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
 icon.animate([
  {transform:'translate(-50%,-50%) scale(.8)',opacity:1,left:`${x1}px`,top:`${y1}px`},
  {transform:'translate(-50%,-50%) scale(1.15)',opacity:1,offset:.65,left:`${(x1+x2)/2}px`,top:`${(y1+y2)/2}px`},
  {transform:'translate(-50%,-50%) scale(.7)',opacity:0,left:`${x2}px`,top:`${y2}px`}
 ],{duration:reduce?1000:1000,easing:'ease-in-out',fill:'forwards'}).onfinish=()=>icon.remove();
}

// Handler tombol top action (pengaturan & pause)
if (typeof document !== 'undefined') {
 document.querySelectorAll('.btn').forEach(b=>{
  b.onclick=()=>toast(b.dataset.m+' – segera hadir');
 });
}

// Sync event listener untuk update HUD & floating popup otomatis
if (typeof window !== 'undefined') {
 window.addEventListener('economy:transaction',(e)=>{
  const detail=e.detail||{};
  if(detail.type==='RENT' && detail.fromPlayerId && detail.toPlayerId)
   animateRentTransfer(detail.fromPlayerId,detail.toPlayerId,detail.amount);
  const {playerId, amount, fromPlayerId, toPlayerId} = e.detail || {};
  if(playerId && amount){
   const pIdx=clientGameStore.getPlayerIndex(playerId);
   if(pIdx!==-1) showMoneyPopup(pIdx, amount);
  }else if(fromPlayerId && toPlayerId && amount){
   const fromIdx=clientGameStore.getPlayerIndex(fromPlayerId);
   const toIdx=clientGameStore.getPlayerIndex(toPlayerId);
   if(fromIdx!==-1) showMoneyPopup(fromIdx, -amount);
   if(toIdx!==-1) showMoneyPopup(toIdx, amount);
  }
 });

}

clientGameStore.subscribe(() => buildHud());
buildHud();
