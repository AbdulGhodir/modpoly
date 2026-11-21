import {clientGameStore} from '../state/ClientGameStore.js';
import {turnManager} from '../logic/TurnManager.js';
import {tileModalManager} from './TileModalManager.js';
import {toast} from './hud.js';
import {socketClient} from '../network/SocketClient.js';
import {getMultiplayerTurnControls} from './multiplayerTurnControls.js';

const PIPS={1:[4],2:[0,8],3:[0,4,8],4:[0,2,6,8],5:[0,2,4,6,8],6:[0,2,3,5,6,8]};
const rnd=()=>1+Math.floor(Math.random()*6);
let busy=false;
const newEndTurnActionId=()=>globalThis.crypto?.randomUUID?.() || `end-turn-${Date.now()}-${Math.random().toString(36).slice(2)}`;

function face(el,n){
  el.innerHTML=Array.from({length:9},(_,i)=>`<i${PIPS[n].includes(i)?' class="o"':''}></i>`).join('');
}

function activeTurnKey(){
  const state=clientGameStore.getState();
  const player=state.getActivePlayer();
  return `${state.round}:${state.currentTurn}:${player?.playerId || player?.id}`;
}

// Animasi putaran dadu ±1 detik, lalu resolve [d1, d2]
function rollDice(box,dice){
  box.classList.add('roll');
  return new Promise(res=>{
    const t=setInterval(()=>dice.forEach(d=>face(d,rnd())),90);
    setTimeout(()=>{
      clearInterval(t);
      const r=dice.map(d=>{const n=rnd();face(d,n);return n});
      box.classList.remove('roll');
      res(r);
    },1000);
  });
}

function animateToOfficialDice(box,dice,values){
  box.classList.add('roll');
  return new Promise(resolve=>{
    const timer=setInterval(()=>dice.forEach(d=>face(d,rnd())),90);
    setTimeout(()=>{
      clearInterval(timer);
      dice.forEach((die,index)=>face(die,values[index]));
      box.classList.remove('roll');
      resolve();
    },850);
  });
}

export function initDice({client=socketClient,getActiveRoom=()=>null,getLocalPlayerId=()=>null}={}){
  const box=document.getElementById('dice'),out=document.getElementById('roll');
  const dice=[...box.querySelectorAll('.die')];
  dice.forEach(d=>face(d,rnd()));

  const isMultiplayer=()=>getActiveRoom()?.status==='started';
  const turnControlsForCurrentState=()=>getMultiplayerTurnControls({state:clientGameStore.getState(),
    store:clientGameStore,room:getActiveRoom(),localPlayerId:getLocalPlayerId(),connected:client.isConnected()});
  const pendingActionHint=state=>{
    const localPlayerId=getLocalPlayerId();
    const debt=clientGameStore.pendingDebt;
    if(debt){
      const player=clientGameStore.getPlayer(debt.playerId);
      return debt.playerId===localPlayerId ? '' : `${player?.name || debt.playerName || 'Pemain'} sedang membayar hutang`;
    }
    const pending=clientGameStore.pendingFreeParkingDecision;
    if(pending?.turnId===state.turnId){
      const player=clientGameStore.getPlayer(pending.playerId);
      return pending.playerId===localPlayerId ? '' : `${player?.name || 'Pemain'} sedang memilih tempat parkir bebas`;
    }
    const active=state.getActivePlayer();
    if((active?.status==='IN_JAIL' || active?.inJail===true) && active.playerId!==localPlayerId)
      return `${active.name} sedang memilih cara keluar penjara`;
    return null;
  };
  const updateMultiplayerControl=()=>{
    if(!isMultiplayer()) return;
    const state=clientGameStore.getState();
    const activePlayer=state.getActivePlayer();
    const activePlayerInJail=activePlayer?.status==='IN_JAIL' || activePlayer?.inJail===true;
    const parkingDecisionPending=clientGameStore.pendingFreeParkingDecision?.playerId===state.activePlayerId &&
      clientGameStore.pendingFreeParkingDecision?.turnId===state.turnId;
    const canRequest=client.isConnected() && state.phase==='WAITING_ROLL' &&
      state.activePlayerId===getLocalPlayerId() && !activePlayerInJail &&
      !parkingDecisionPending &&
      clientGameStore.presentation.movement?.status!=='ANIMATING';
    const turnControls=turnControlsForCurrentState();
    if(state.phase==='PLAYER_ACTION'){
      const disabled=busy?' disabled':'';
      const rollAgain=turnControls.showRollAgain
        ? `<button id="btn-roll-again" class="btn-end-turn btn-roll-again pulse" type="button"${disabled}>Kocok Lagi</button>`:'';
      const endTurn=turnControls.showEndTurn
        ? `<button id="btn-end-turn" class="btn-end-turn btn-finish-turn pulse" type="button"${disabled}>Selesai Giliran ➔</button>`:'';
      const content=turnControls.showRollAgain
        ? `<span class="dice-double">Dadu Double 🎲</span>${rollAgain}`
        : turnControls.showEndTurn
          ? endTurn
          : activePlayer?.playerId===getLocalPlayerId()
          ? ''
          : `Menunggu ${activePlayer?.name || 'pemain aktif'} bertindak`;
      if(out.innerHTML!==content) out.innerHTML=content;
      box.classList.toggle('disabled',!turnControls.showRollAgain || busy);
    }else{
      box.classList.toggle('disabled',!canRequest || busy);
    }
    const pendingHint=pendingActionHint(state);
    if(pendingHint!==null && ['WAITING_ROLL','DEBT_RESOLUTION'].includes(state.phase)){
      out.textContent=pendingHint;
    }else if(state.phase==='WAITING_ROLL' && (activePlayerInJail || parkingDecisionPending)){
      out.textContent='';
    }else if(state.phase==='WAITING_ROLL'){
      out.textContent=state.activePlayerId===getLocalPlayerId()
        ? 'Klik dadu 🎲'
        : `Menunggu ${activePlayer?.name || 'pemain aktif'} melempar`;
    }
  };
  const resetMultiplayerResult=()=>{
    dice.forEach(die=>face(die,1));
    const state=clientGameStore.getState();
    out.textContent='';
    if(state.phase==='GAME_OVER') out.textContent='';
    else if(pendingActionHint(state)!==null) out.textContent=pendingActionHint(state);
    else if(state.phase==='WAITING_ROLL'){
      const active=state.getActivePlayer();
      const parking=clientGameStore.pendingFreeParkingDecision?.playerId===state.activePlayerId;
      const jailed=active?.status==='IN_JAIL' || active?.inJail===true;
      out.textContent=jailed || parking
        ? ''
        : active?.playerId===getLocalPlayerId()
        ? 'Klik dadu 🎲'
        : `Menunggu ${active?.name || 'pemain aktif'} melempar`;
    }
  };

  const unsubscribeStore=clientGameStore.subscribe(({change})=>{
    if(change.type==='turn-ended' || change.type==='snapshot') busy=false;
    if(isMultiplayer() && (change.type==='turn-ended' || change.type==='snapshot' || change.type==='player-jailed'))
      resetMultiplayerResult();
    if(isMultiplayer()) updateMultiplayerControl();
    if(change.type==='dice-rolled'){
      const {die1,die2,total,turnId}=change.detail;
      busy=true;
      box.classList.add('disabled');
      out.textContent='...';
      clientGameStore.beginDiceAnimation(turnId);
      animateToOfficialDice(box,dice,[die1,die2]).catch(error=>{
        console.error('Animasi dadu authoritative gagal:',error);
      }).finally(()=>{
        dice.forEach((die,index)=>face(die,[die1,die2][index]));
        const showDouble=die1===die2 && !change.detail.jailAttempt && !change.detail.tripleDouble;
        out.innerHTML=`<span class="dice-total">${total}</span>`+(showDouble?'<br><span class="dice-double">Dadu Double!</span>':'');
        busy=false;
        updateMultiplayerControl();
        clientGameStore.completeDiceAnimation(turnId);
      });
      return;
    }
    if(change.type==='snapshot') updateMultiplayerControl();
    if(change.type==='turn-ended'){
      resetMultiplayerResult();
      updateMultiplayerControl();
      return;
    }
    if(change.type==='tile-unsupported'){
      out.textContent='';
      box.classList.add('disabled');
      return;
    }
    if(change.type==='chance-resolved'){
      if(!change.detail?.supported) box.classList.add('disabled');
      out.textContent='';
      updateMultiplayerControl();
      return;
    }
    if(change.type==='rent-resolved'){
      if(change.detail?.rent?.outcome==='INSUFFICIENT_FUNDS') box.classList.add('disabled');
      out.textContent='';
      updateMultiplayerControl();
      return;
    }
    if(change.type==='property-resolved' || change.type==='turn-advanced' || change.type==='tile-resolved'){
      updateMultiplayerControl();
    }
    if(change.type==='tile-resolved'){
      updateMultiplayerControl();
      return;
    }
    if(change.type==='player-jailed'){
      updateMultiplayerControl();
      return;
    }
    if(change.type==='jail-action-resolved'){
      updateMultiplayerControl();
    }
    if(change.type==='free-parking-decision-resolved'){
      updateMultiplayerControl();
    }
    if(change.type==='movement-animation-complete' || change.type==='debt-resolved' || change.type==='auction-ended') updateMultiplayerControl();
  });
  const refreshMultiplayerRollHint=()=>{
    if(!isMultiplayer()) return;
    const state=clientGameStore.getState();
    if(state.phase==='WAITING_ROLL' && !state.lastRoll) resetMultiplayerResult();
    updateMultiplayerControl();
  };
  const unsubscribeRoomStarted=client.on('room:started',refreshMultiplayerRollHint);
  const unsubscribeInitialSnapshot=client.on('game:initial-snapshot',refreshMultiplayerRollHint);
  client.onStatusChange(updateMultiplayerControl);

  box.onclick=async(e)=>{
    const rollAgainButton=e.target?.closest?.('#btn-roll-again');
    const endTurnButton=e.target?.closest?.('#btn-end-turn');
    if(rollAgainButton || endTurnButton){
      e.preventDefault();
      e.stopPropagation();
    }

    if(isMultiplayer()){
      const state=clientGameStore.getState();
      const playerId=getLocalPlayerId();
      if(endTurnButton){
        if(busy || !turnControlsForCurrentState().showEndTurn) return;
        busy=true;
        updateMultiplayerControl();
        const actionId=newEndTurnActionId();
        const requestTurnId=state.turnId;
        const response=await client.request('game:end-turn',{turnId:requestTurnId,actionId});
        if(response?.ok){
          const applied=clientGameStore.applyTurnEnded(response.result);
          const current=clientGameStore.getState();
          if(!applied && current.turnId===requestTurnId && current.activePlayerId===playerId){
            busy=false;
            toast('Konfirmasi selesai giliran belum dapat diterapkan.');
          }
        }else{
          busy=false;
          const current=clientGameStore.getState();
          if(current.turnId===requestTurnId && current.activePlayerId===playerId){
            toast(response?.error?.message || 'Permintaan selesai giliran gagal.');
          }
        }
        updateMultiplayerControl();
        return;
      }
      const controls=turnControlsForCurrentState();
      const extraRoll=Boolean(rollAgainButton);
      if(busy || !client.isConnected() || state.activePlayerId!==playerId ||
        (extraRoll ? !controls.showRollAgain : state.phase!=='WAITING_ROLL') ||
        (!extraRoll && clientGameStore.pendingFreeParkingDecision?.turnId===state.turnId)) return;
      busy=true;
      box.classList.add('disabled');
      out.textContent='...';
      const response=await client.request('game:roll-dice',{turnId:state.turnId});
      if(!response.ok){
        busy=false;
        updateMultiplayerControl();
        toast(response.error?.message || 'Permintaan lempar dadu gagal.');
      }
      return;
    }

    if(busy || !turnManager.canRoll()){
      if(tileModalManager && tileModalManager.isMinimized()){
        toast('Buka kembali modal properti di bagian bawah layar untuk melanjutkan!');
      }
      return;
    }

    busy=true;
    box.classList.add('disabled');
    if (!turnManager.startRolling()) {
      busy=false;
      box.classList.remove('disabled');
      return;
    }
    out.textContent='...';

    const r=await rollDice(box,dice);
    const total=r[0]+r[1];
    const isDouble=(r[0]===r[1]);

    const rollData={dice:r,total,isDouble};
    clientGameStore.getState().lastRoll=rollData;

    // Evaluasi hasil dadu via TurnManager (memproses aturan 3x double & percobaan keluar penjara)
    const rollResult=turnManager.handleRoll(rollData);

    if(rollResult.jailed3xDouble){
      out.innerHTML=`
        <span class="dice-total">${total}</span><br><span class="dice-double">Dadu Double!</span>
        <button id="btn-end-turn" data-turn-key="${activeTurnKey()}" class="btn-end-turn btn-finish-turn pulse" type="button">Selesai Giliran ➔</button>
      `;
      busy=false;
      return;
    }

    if(rollResult.stayInJail){
      out.innerHTML=`
        <span class="dice-total">${total}</span>
        <button id="btn-end-turn" data-turn-key="${activeTurnKey()}" class="btn-end-turn btn-finish-turn pulse" type="button">Selesai Giliran ➔</button>
      `;
      busy=false;
      return;
    }

    out.innerHTML=`<span class="dice-total">${total}</span>`+(isDouble?'<br><span class="dice-double">Dadu Double!</span>':'');

    turnManager.startMoving(rollData);
    window.dispatchEvent(new CustomEvent('dice:rolled',{detail:{...rollData, ...rollResult}}));
  };

  // Delegasi klik global dokumen untuk memastikan tombol Selesai Giliran selalu merespons
  document.addEventListener('click',(e)=>{
    if(e.target && (e.target.id==='btn-end-turn' || e.target.closest('#btn-end-turn'))){
      if(isMultiplayer()) return;
      e.preventDefault();
      e.stopPropagation();
      turnManager.endTurn(e.target.closest('#btn-end-turn')?.dataset.turnKey || null);
    }
  });

  // Fase aksi pemain: menampilkan opsi Lempar Lagi (jika Double) atau Selesai Giliran
  window.addEventListener('turn:action',(e)=>{
    const {allowExtraRoll}=e.detail;
    busy=false; // Buka kunci interaksi tombol

    if(allowExtraRoll){
      box.classList.remove('disabled');
      out.innerHTML=`
        <span class="dice-double">Double! 🎲</span>
        <button id="btn-roll-again" class="btn-end-turn btn-roll-again pulse" type="button">Lempar Lagi</button>
      `;
    }else{
      box.classList.add('disabled'); // Kunci dadu agar tidak dikocok ulang, tapi biarkan tombol selesai giliran aktif
      out.innerHTML=`<button id="btn-end-turn" data-turn-key="${activeTurnKey()}" class="btn-end-turn btn-finish-turn pulse" type="button">Selesai Giliran ➔</button>`;
    }
  });

  // Giliran siap: reset status dadu untuk giliran pemain berikutnya
  window.addEventListener('turn:ready',()=>{
    busy=false;
    if(isMultiplayer()){
      updateMultiplayerControl();
    }else{
      box.classList.remove('disabled');
      out.textContent='Klik dadu 🎲';
    }
  });

  // Saat modal terbuka, cegah interaksi lempar dadu
  window.addEventListener('modal:opened',()=>{
    box.classList.add('disabled');
  });

  window.addEventListener('modal:closed',()=>{
    if(turnManager.canRoll()){
      box.classList.remove('disabled');
    }
  });

  window.addEventListener('tilemodal:opened',()=>{
    box.classList.add('disabled');
  });

  window.addEventListener('tilemodal:closed',()=>{
    if(isMultiplayer()){
      const state=clientGameStore.getState();
      const active=state.getActivePlayer();
      if(state.phase==='WAITING_ROLL'){
        out.textContent=active?.playerId===getLocalPlayerId()
          ? 'Klik dadu 🎲'
          : `Menunggu ${active?.name || 'pemain aktif'} melempar`;
      }
      updateMultiplayerControl();
    }else if(turnManager.canRoll()){
      box.classList.remove('disabled');
    }
  });

  return ()=>{
    unsubscribeStore();
    unsubscribeRoomStarted();
    unsubscribeInitialSnapshot();
  };
}
