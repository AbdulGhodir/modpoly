import Phaser from 'phaser';
import './style.css';
import {GameScene} from './scenes/GameScene.js';
import './ui/hud.js';
import {initDice} from './ui/dice.js';
import {measureViewport} from './ui/viewport.js';
import {initFullscreen} from './ui/fullscreen.js';
import {clientGameStore} from './state/ClientGameStore.js';
import {socketClient} from './network/SocketClient.js';
import {initLobby} from './network/LobbyManager.js';
import {applyInitialSnapshot, initInitialSnapshotSync} from './network/InitialSnapshotSync.js';
import {initAuthoritativeDiceSync} from './network/AuthoritativeDiceSync.js';
import {initPlayerMovementSync} from './network/PlayerMovementSync.js';
import {initPropertyResolutionSync} from './network/PropertyResolutionSync.js';
import {initMultiplayerPropertyOffer} from './ui/MultiplayerPropertyOffer.js';
import {initChanceResolutionSync} from './network/ChanceResolutionSync.js';
import {initChancePresentationSync} from './network/ChancePresentationSync.js';
import {initRentResolutionSync} from './network/RentResolutionSync.js';
import {initDebtResolutionSync} from './network/DebtResolutionSync.js';
import {initPropertyFinanceSync} from './network/PropertyFinanceSync.js';
import {initAuctionResolutionSync} from './network/AuctionResolutionSync.js';
import {initMultiplayerChanceResolution} from './ui/MultiplayerChanceResolution.js';
import {initMultiplayerRentResolution} from './ui/MultiplayerRentResolution.js';
import {initMultiplayerAuction} from './ui/MultiplayerAuction.js';
import {initTradeResolutionSync} from './network/TradeResolutionSync.js';
import {initMultiplayerTrade} from './ui/MultiplayerTrade.js';
import {initBuildingResolutionSync} from './network/BuildingResolutionSync.js';
import {initJailResolutionSync} from './network/JailResolutionSync.js';
import {initMultiplayerJail} from './ui/MultiplayerJail.js';
import {initFreeParkingResolutionSync} from './network/FreeParkingResolutionSync.js';
import {initTurnFlowSync} from './network/TurnFlowSync.js';
import {initMultiplayerMoneyAnimation} from './ui/MultiplayerMoneyAnimation.js';
import {initMultiplayerFreeParking} from './ui/MultiplayerFreeParking.js';
import {freeParkingModalManager} from './ui/FreeParkingModalManager.js';
import {toast, setHudMultiplayerContext} from './ui/hud.js';
import {tileModalManager} from './ui/TileModalManager.js';
import {tradeModalManager} from './ui/TradeModalManager.js';
import {modalManager} from './ui/ModalManager.js';
import {debtResolutionModalManager} from './ui/DebtResolutionModalManager.js';
import {configureLocalGame} from './logic/localGame.js';
import {turnManager} from './logic/TurnManager.js';
import {buildHud} from './ui/hud.js';
import {TILES} from './data/tiles.js';

configureLocalGame({ turnManager, buildHud, toast, tiles: TILES });

const rotateHint = document.getElementById('rotate-hint');
const rotateOk = document.getElementById('rotate-ok');
window.addEventListener('game:ready', () => {
  document.body.classList.remove('app-loading');
  document.body.classList.add('app-ready');
  window.setTimeout(() => document.getElementById('boot-screen')?.remove(), 350);
}, {once: true});
if (rotateHint && rotateOk) {
  rotateOk.onclick = () => rotateHint.classList.add('dismissed');
}

clientGameStore.bindEvents(window);
const lobby = initLobby();
const multiplayerContext = {client: socketClient, getActiveRoom: () => lobby.getRoomState(), getLocalPlayerId: () => lobby.playerId};
setHudMultiplayerContext(multiplayerContext);
modalManager.setMultiplayerContext(multiplayerContext);
debtResolutionModalManager.setContext({getActiveRoom: () => lobby.getRoomState(), getLocalPlayerId: () => lobby.playerId});
tradeModalManager.setMultiplayerContext({client: socketClient, getActiveRoom: () => lobby.getRoomState(),
  getLocalPlayerId: () => lobby.playerId});
const initialSnapshotContext = {client: socketClient, store: clientGameStore, getActiveRoom: () => lobby.getRoomState()};
initInitialSnapshotSync(initialSnapshotContext);
lobby.setSessionRestoredHandler(payload => applyInitialSnapshot({...initialSnapshotContext, payload}));
initAuthoritativeDiceSync({
  client: socketClient,
  store: clientGameStore,
  getActiveRoom: () => lobby.getRoomState()
});
initPlayerMovementSync({client: socketClient, store: clientGameStore, getActiveRoom: () => lobby.getRoomState(), tileCount: TILES.length});
initPropertyResolutionSync({client: socketClient, store: clientGameStore, getActiveRoom: () => lobby.getRoomState()});
initChanceResolutionSync({client: socketClient, store: clientGameStore, getActiveRoom: () => lobby.getRoomState(), tiles: TILES});
initChancePresentationSync({client: socketClient, store: clientGameStore, getActiveRoom: () => lobby.getRoomState()});
initRentResolutionSync({client: socketClient, store: clientGameStore, getActiveRoom: () => lobby.getRoomState()});
initDebtResolutionSync({client: socketClient, store: clientGameStore, getActiveRoom: () => lobby.getRoomState()});
initPropertyFinanceSync({client: socketClient, store: clientGameStore, getActiveRoom: () => lobby.getRoomState()});
initAuctionResolutionSync({client: socketClient, store: clientGameStore, getActiveRoom: () => lobby.getRoomState()});
initTradeResolutionSync({client: socketClient, store: clientGameStore, getActiveRoom: () => lobby.getRoomState()});
initBuildingResolutionSync({client: socketClient, store: clientGameStore, getActiveRoom: () => lobby.getRoomState()});
initJailResolutionSync({client: socketClient, store: clientGameStore, getActiveRoom: () => lobby.getRoomState()});
initFreeParkingResolutionSync({client: socketClient, store: clientGameStore, getActiveRoom: () => lobby.getRoomState()});
initTurnFlowSync({client: socketClient, store: clientGameStore, getActiveRoom: () => lobby.getRoomState()});
initMultiplayerMoneyAnimation({store: clientGameStore, getActiveRoom: () => lobby.getRoomState()});
initMultiplayerPropertyOffer({
  client: socketClient,
  store: clientGameStore,
  modalManager: tileModalManager,
  getActiveRoom: () => lobby.getRoomState(),
  getLocalPlayerId: () => lobby.playerId
});
initMultiplayerChanceResolution({client: socketClient, store: clientGameStore, modalManager: tileModalManager,
  getActiveRoom: () => lobby.getRoomState(), getLocalPlayerId: () => lobby.playerId});
initMultiplayerRentResolution({store: clientGameStore, modalManager: tileModalManager});
initMultiplayerAuction({client: socketClient, store: clientGameStore, modalManager: tileModalManager,
  getActiveRoom: () => lobby.getRoomState(), getLocalPlayerId: () => lobby.playerId});
initMultiplayerTrade({client: socketClient, store: clientGameStore, modalManager: tradeModalManager,
  getActiveRoom: () => lobby.getRoomState(), getLocalPlayerId: () => lobby.playerId});
initMultiplayerJail({client: socketClient, store: clientGameStore, getActiveRoom: () => lobby.getRoomState(),
  getLocalPlayerId: () => lobby.playerId});
initMultiplayerFreeParking({client: socketClient, store: clientGameStore, modal: freeParkingModalManager,
  getActiveRoom: () => lobby.getRoomState(),
  getLocalPlayerId: () => lobby.playerId, notify: toast});
// Koneksi opsional: tanpa VITE_SOCKET_URL, game single-player tetap berjalan offline.
initFullscreen({client: socketClient});
socketClient.connect();

initDice({
  client: socketClient,
  getActiveRoom: () => lobby.getRoomState(),
  getLocalPlayerId: () => lobby.playerId
});
// Banner "putar layar" (portrait HP) – bisa ditutup, tidak memblokir game
document.getElementById('rotate-ok')?.addEventListener('click',()=>document.getElementById('rotate-hint')?.classList.add('dismissed'));

Promise.race([document.fonts.ready,new Promise(r=>setTimeout(r,1200))]).catch(()=>{}).then(()=>{
  const vp=measureViewport();
  // Canvas dibuat sebesar piksel FISIK (w*DPR) lalu ditampilkan 1/DPR via zoom → tidak ada upscale blur.
  const game=new Phaser.Game({
    type:Phaser.AUTO,
    parent:'g',
    transparent:true,
    scene:GameScene,
    scale:{mode:Phaser.Scale.NONE,width:Math.round(vp.w*vp.d),height:Math.round(vp.h*vp.d),zoom:1/vp.d},
    render:{antialias:true,antialiasGL:true,roundPixels:true,powerPreference:'high-performance'}
  });

  let last=`${vp.w}x${vp.h}@${vp.d}`,timer;
  const apply=()=>{
    const v=measureViewport(),key=`${v.w}x${v.h}@${v.d}`;
    if(key===last) return;
    last=key;
    const sm=game.scale;
    sm.setZoom(1/v.d);
    sm.resize(Math.round(v.w*v.d),Math.round(v.h*v.d)); // memicu event 'resize' → GameScene.fit()
    const c=game.canvas;
    c.style.width=v.w+'px';c.style.height=v.h+'px';
    sm.updateBounds();
  };
  // debounce: resize/rotasi memicu banyak event beruntun
  const schedule=()=>{clearTimeout(timer);timer=setTimeout(apply,90)};
  window.addEventListener('resize',schedule);
  window.addEventListener('orientationchange',()=>{schedule();setTimeout(schedule,350)});
  window.visualViewport?.addEventListener('resize',schedule);
  screen.orientation?.addEventListener?.('change',()=>{schedule();setTimeout(schedule,350)});
  document.addEventListener('fullscreenchange',()=>{schedule();setTimeout(schedule,300)});
});
