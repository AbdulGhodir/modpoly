import test from 'node:test';
import assert from 'node:assert/strict';
import {GameState} from '../src/logic/GameStateCore.js';
import {ClientGameStore} from '../src/state/ClientGameStore.js';
import {ServerGameState} from '../server/src/game/ServerGameState.js';
import {initTurnFlowSync} from '../src/network/TurnFlowSync.js';
import {canShowPlayerActionMenu, getMultiplayerTurnControls} from '../src/ui/multiplayerTurnControls.js';

class FakeClient {
  listeners = new Map();
  on(name, listener) { this.listeners.set(name, listener); return () => this.listeners.delete(name); }
  emit(name, payload) { return this.listeners.get(name)?.(payload); }
}

function makeServer(roomCode='TURN01') {
  return new ServerGameState({roomCode, roster:[
    {playerId:'p1',playerName:'Pemain 1'}, {playerId:'p2',playerName:'Pemain 2'}
  ]});
}

function room(server) {
  return {roomCode:server.roomCode,status:'started',minPlayers:2,maxPlayers:4,players:[
    {playerId:'p1',isConnected:true},{playerId:'p2',isConnected:true}
  ]};
}

test('turn-ended applies only the confirmed same-room event once; client does not advance optimistically', () => {
  const server=makeServer();
  server.state.phase='PLAYER_ACTION';
  const store=new ClientGameStore(new GameState());
  store.setSnapshot(server.toPublicSnapshot());
  const activeRoom=room(server), client=new FakeClient();
  initTurnFlowSync({client,store,getActiveRoom:()=>activeRoom,logger:{warn(){}}});
  const response=server.endTurn({playerId:'p1',turnId:server.state.turnId,actionId:'end-action-1'});
  assert.equal(response.ok,true);
  assert.equal(store.getState().activePlayerId,'p1','server mutation alone must not update the client');
  assert.equal(client.emit('game:turn-ended',response.result),true);
  assert.equal(store.getState().activePlayerId,'p2');
  assert.equal(store.getPhase(),'WAITING_ROLL');
  assert.equal(store.getState().turnId,2);
  assert.equal(client.emit('game:turn-ended',response.result),false,'duplicate event cannot move the client again');
  const before=store.getSnapshot();
  assert.equal(client.emit('game:turn-ended',{...response.result,roomCode:'OTHER1'}),false);
  assert.deepEqual(store.getSnapshot(),before);
});

test('PLAYER_ACTION controls follow active player, blockers, connection, and official extra-roll snapshot', () => {
  const server=makeServer('TURN02');
  server.state.phase='PLAYER_ACTION';
  server.extraRollAvailable=true;
  const store=new ClientGameStore(new GameState());
  store.setSnapshot(server.toPublicSnapshot());
  const activeRoom=room(server);
  const control=(localPlayerId='p1',connected=true)=>getMultiplayerTurnControls({state:store.getState(),store,
    room:activeRoom,localPlayerId,connected});
  assert.equal(control().showEndTurn,false);
  assert.equal(control().showRollAgain,true);
  assert.equal(control('p2').showEndTurn,false);
  assert.equal(control('p2').showRollAgain,false);
  assert.equal(control('p1',false).showEndTurn,false);
  assert.equal(canShowPlayerActionMenu({state:store.getState(),store,room:activeRoom,localPlayerId:'p1',connected:true}),true);
  assert.equal(canShowPlayerActionMenu({state:store.getState(),store,room:activeRoom,localPlayerId:'p2',connected:true}),false);

  store.extraRollAvailable=false;
  assert.equal(control().showEndTurn,true);
  assert.equal(control().showRollAgain,false);
  for (const phase of ['DEBT_RESOLUTION','WAITING_AUCTION_ACTION','WAITING_PROPERTY_DECISION','CHANCE_PRESENTATION','MOVING','GAME_OVER']) {
    store.getState().phase=phase;
    assert.equal(control().showEndTurn,false,`${phase} hides turn controls`);
    assert.equal(control().showRollAgain,false,`${phase} hides extra roll`);
  }
  store.getState().phase='PLAYER_ACTION';
  store.pendingChancePresentation={presentationId:'pending'};
  assert.equal(control().showEndTurn,false,'pending Chance presentation blocks end turn');
  store.pendingChancePresentation=null;
  store.presentation.movements.set('queued-move',{movementId:'queued-move',status:'ANIMATING'});
  assert.equal(control().showEndTurn,false,'any queued movement still animating blocks end turn');

  const restored=makeServer('TURN03');
  restored.state.phase='PLAYER_ACTION';
  restored.extraRollAvailable=true;
  const reconnectStore=new ClientGameStore(new GameState());
  reconnectStore.setSnapshot(restored.toPublicSnapshot());
  assert.equal(reconnectStore.getExtraRollAvailable(),true);
  assert.equal(getMultiplayerTurnControls({state:reconnectStore.getState(),store:reconnectStore,room:room(restored),
    localPlayerId:'p1',connected:true}).showRollAgain,true,'reconnect restores the official double right');
  assert.equal(getMultiplayerTurnControls({state:reconnectStore.getState(),store:reconnectStore,room:room(restored),
    localPlayerId:'p1',connected:true}).showEndTurn,false,'reconnect cannot opt out of the saved double right');
});
