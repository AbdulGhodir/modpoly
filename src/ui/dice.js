import {GAME, gameState} from '../data/players.js';
import {turnManager} from '../logic/TurnManager.js';
import {tileModalManager} from './TileModalManager.js';
import {toast} from './hud.js';

const PIPS={1:[4],2:[0,8],3:[0,4,8],4:[0,2,6,8],5:[0,2,4,6,8],6:[0,2,3,5,6,8]};
const rnd=()=>1+Math.floor(Math.random()*6);
let busy=false;

function face(el,n){
  el.innerHTML=Array.from({length:9},(_,i)=>`<i${PIPS[n].includes(i)?' class="o"':''}></i>`).join('');
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

export function initDice(){
  const box=document.getElementById('dice'),out=document.getElementById('roll');
  const dice=[...box.querySelectorAll('.die')];
  dice.forEach(d=>face(d,rnd()));

  box.onclick=async(e)=>{
    // Jika klik berasal dari tombol Selesai Giliran
    if(e.target && (e.target.id==='btn-end-turn' || e.target.closest('#btn-end-turn'))){
      e.preventDefault();
      e.stopPropagation();
      turnManager.endTurn();
      return;
    }

    // Jika klik berasal dari tombol Lempar Lagi (Double)
    if(e.target && (e.target.id==='btn-roll-again' || e.target.closest('#btn-roll-again'))){
      e.preventDefault();
      e.stopPropagation();
    }

    if(busy || !turnManager.canRoll()){
      if(tileModalManager && tileModalManager.isMinimized()){
        toast('Buka kembali modal properti di bagian bawah layar untuk melanjutkan!');
      }
      return;
    }

    busy=true;
    box.classList.add('disabled');
    turnManager.startRolling();
    out.textContent='...';

    const r=await rollDice(box,dice);
    const total=r[0]+r[1];
    const isDouble=(r[0]===r[1]);

    const rollData={dice:r,total,isDouble};
    GAME.lastRoll=rollData;
    gameState.lastRoll=rollData;

    // Evaluasi hasil dadu via TurnManager (memproses aturan 3x double & percobaan keluar penjara)
    const rollResult=turnManager.handleRoll(rollData);

    if(rollResult.jailed3xDouble){
      out.innerHTML=`
        <span class="dice-double" style="color:#ef4444">3x Double! 👮‍♂️</span>
        <div style="font-size:11px;font-weight:700;color:#ef4444;margin:4px 0">Masuk Penjara!</div>
        <button id="btn-end-turn" class="btn-end-turn btn-finish-turn pulse" type="button">Selesai Giliran ➔</button>
      `;
      busy=false;
      return;
    }

    if(rollResult.stayInJail){
      out.innerHTML=`
        <span class="dice-total">${total}</span>
        <div style="font-size:11px;font-weight:700;color:#b91c1c;margin:4px 0">Gagal Double (${r[0]}+${r[1]})</div>
        <button id="btn-end-turn" class="btn-end-turn btn-finish-turn pulse" type="button">Selesai Giliran ➔</button>
      `;
      busy=false;
      return;
    }

    out.innerHTML=`<span class="dice-total">${total}</span>`+(isDouble?'<br><span class="dice-double">Double!</span>':'');

    turnManager.startMoving(rollData);
    window.dispatchEvent(new CustomEvent('dice:rolled',{detail:{...rollData, ...rollResult}}));
  };

  // Delegasi klik global dokumen untuk memastikan tombol Selesai Giliran selalu merespons
  document.addEventListener('click',(e)=>{
    if(e.target && (e.target.id==='btn-end-turn' || e.target.closest('#btn-end-turn'))){
      e.preventDefault();
      e.stopPropagation();
      turnManager.endTurn();
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
      out.innerHTML=`<button id="btn-end-turn" class="btn-end-turn btn-finish-turn pulse" type="button">Selesai Giliran ➔</button>`;
    }
  });

  // Giliran siap: reset status dadu untuk giliran pemain berikutnya
  window.addEventListener('turn:ready',()=>{
    busy=false;
    box.classList.remove('disabled');
    out.textContent='Klik dadu 🎲';
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
    if(turnManager.canRoll()){
      box.classList.remove('disabled');
    }
  });
}
