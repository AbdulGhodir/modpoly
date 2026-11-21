import test from 'node:test';
import assert from 'node:assert/strict';
import {GameStatus, PlayerStatus} from '../../src/logic/GameStateCore.js';
import {ServerGameState, createServerGameState} from '../src/game/ServerGameState.js';
import {loadBoardCatalog} from '../src/game/loadBoardCatalog.js';
import {createPropertyRecord} from '../../src/logic/propertyState.js';
import {CHANCE_CARDS} from '../../src/data/cards.js';
import {ChanceDeck} from '../src/game/ChanceDeck.js';
import {calculatePropertyRent} from '../../src/logic/rent.js';
import {getMortgageEligibility, getUnmortgageEligibility} from '../../src/logic/mortgage.js';

const roster = (count, prefix = 'member') => Array.from({length: count}, (_, seat) => ({
  playerId: `${prefix}-${seat + 1}`,
  playerName: `${prefix} ${seat + 1}`
}));

test('creates a Node-safe room state using roster player IDs, names, and unique ordered seats', () => {
  const serverState = createServerGameState({roomCode: 'AB2CD3', roster: roster(3)});
  const state = serverState.state;

  assert.equal(state.gameStatus, GameStatus.IN_GAME);
  assert.equal(state.players.length, 3);
  assert.deepEqual(state.players.map(player => player.playerId), ['member-1', 'member-2', 'member-3']);
  assert.deepEqual(state.players.map(player => player.name), ['member 1', 'member 2', 'member 3']);
  assert.deepEqual(state.players.map(player => player.seat), [0, 1, 2]);
  assert.equal(new Set(state.players.map(player => player.seat)).size, 3);
  assert.ok(state.players.every(player => player.status === PlayerStatus.ACTIVE));
  assert.equal('socketId' in state.players[0], false);
  assert.equal(state.properties.size, 28);
  assert.deepEqual(state.properties.get(1), createPropertyRecord(loadBoardCatalog().TILES.find(tile => tile.pos === 1)));
});

test('rejects duplicate player IDs and invalid roster sizes', () => {
  assert.throws(() => createServerGameState({roomCode: 'AB2CD3', roster: roster(1)}), /Roster harus/);
  assert.throws(() => createServerGameState({roomCode: 'AB2CD3', roster: roster(5)}), /Roster harus/);
  assert.throws(() => createServerGameState({
    roomCode: 'AB2CD3',
    roster: [{playerId: 'same', playerName: 'One'}, {playerId: 'same', playerName: 'Two'}]
  }), /playerId unik/);
});

test('rejects snapshots whose player seats are repeated or out of order', () => {
  const snapshot = createServerGameState({roomCode: 'AB2CD3', roster: roster(2)}).toSnapshot();
  snapshot.gameState.players[1].seat = 0;
  assert.throws(() => ServerGameState.fromSnapshot(snapshot), /Seat snapshot/);
});

test('snapshot is detached, JSON-serializable, and restores players and property Map entries', () => {
  const original = createServerGameState({roomCode: 'EF4GH5', roster: roster(2, 'restore')});
  original.state.players[0].money = 1234;
  original.state.properties.set(7, {id: 'prop_7', owner: 'restore-1', houses: 2});
  original.state.transactions.push({id: 'tx-1', players: ['restore 1'], amount: 25, type: 'TEST'});

  const snapshot = original.toSnapshot();
  assert.doesNotThrow(() => JSON.stringify(snapshot));
  assert.equal(Array.isArray(snapshot.gameState.properties), true);
  assert.equal('socketId' in snapshot.gameState.players[0], false);
  original.state.players[0].money = 1;
  original.state.properties.get(7).houses = 4;

  const restored = ServerGameState.fromSnapshot(JSON.parse(JSON.stringify(snapshot)));
  assert.equal(restored.roomCode, 'EF4GH5');
  assert.equal(restored.state.players[0].money, 1234);
  assert.equal(restored.state.properties.get(7).houses, 2);
  assert.equal(restored.state.getSeatByPlayerId('restore-2'), 1);
  assert.equal(restored.state.transactions[0].id, 'tx-1');
});

test('server snapshots preserve Chance deck order and replay guards', () => {
  const original = createServerGameState({roomCode: 'DECK01', roster: roster(2, 'deck')});
  original.chanceDeck.draw();
  original.chanceDeck.draw();
  original.processedChanceResolutionIds.add('chance-done');
  original.processedRentResolutionIds.add('rent-done');
  original.processedPropertyFinanceResolutionIds.add('finance-done');
  const snapshot = JSON.parse(JSON.stringify(original.toSnapshot()));
  const expectedChanceOrder = [...original.chanceDeck.activeDeck.map(card => card.id)];
  const restored = ServerGameState.fromSnapshot(snapshot);

  assert.deepEqual(restored.chanceDeck.activeDeck.map(card => card.id), expectedChanceOrder);
  assert.deepEqual(restored.chanceDeck.discardPile.map(card => card.id), original.chanceDeck.discardPile.map(card => card.id));
  assert.equal(restored.processedChanceResolutionIds.has('chance-done'), true);
  assert.equal(restored.processedRentResolutionIds.has('rent-done'), true);
  assert.equal(restored.processedPropertyFinanceResolutionIds.has('finance-done'), true);
  assert.deepEqual(restored.chanceDeck.draw(), original.chanceDeck.draw());
});

test('Chance effect waits for recipient continue and presentation resumes from snapshot exactly once', () => {
  const game = createServerGameState({roomCode: 'CHANCE', roster: roster(2, 'show')});
  const card = CHANCE_CARDS.find(item => item.id === 'ch_1');
  const player = game.state.players[0];
  player.pos = 2;
  game.state.phase = 'WAITING_TILE_RESOLUTION';
  game.state.lastRoll = {dice: [1, 2], total: 3, isDouble: false, consecutiveDoubles: 0, movementId: 'chance-move'};
  game.chanceDeck = {draw: () => ({...card})};
  const opened = game.resolveLandedTile({playerId: player.playerId, turnId: 1,
    movementId: 'chance-move', resolutionId: 'chance-present-1'});
  const presentation = opened.resolution.event;
  assert.equal(opened.resolution.kind, 'CHANCE_PRESENTATION');
  assert.equal(player.money, 1500);
  assert.equal(game.state.transactions.length, 0);
  assert.equal(game.state.phase, 'CHANCE_PRESENTATION');
  assert.deepEqual(game.toPublicSnapshot().pendingChancePresentation.pendingPlayerIds, ['show-1']);

  const restored = ServerGameState.fromSnapshot(JSON.parse(JSON.stringify(game.toSnapshot())));
  assert.equal(restored.toPublicSnapshot().pendingChancePresentation.event.card.id, 'ch_1');
  const args = {playerId: 'show-1', turnId: 1, resolutionId: 'chance-present-1',
    presentationId: presentation.presentationId, actionId: 'chance-continue-one'};
  assert.equal(restored.continueChancePresentation({...args, playerId: 'show-2'}).ok, false);
  const result = restored.continueChancePresentation(args);
  assert.equal(result.ok, true);
  assert.equal(restored.state.players[0].money, 1600);
  assert.equal(restored.state.transactions.length, 1);
  assert.equal(restored.state.phase, 'PLAYER_ACTION');
  assert.equal(restored.continueChancePresentation(args).result.duplicate, true);
  assert.equal(restored.state.players[0].money, 1600);
  assert.equal(restored.continueChancePresentation({...args, actionId: 'chance-second-action'}).ok, false);
});

test('all sixteen Chance categories remain unapplied during presentation', () => {
  for (const card of CHANCE_CARDS) {
    const game = createServerGameState({roomCode: `C${card.id.toUpperCase()}`.slice(0, 6), roster: roster(2, card.id),
      chanceDeck: {draw: () => ({...card})}});
    const player = game.state.players[0]; player.pos = 2;
    const property = game.state.properties.get(1); property.owner = player.playerId; property.houses = 1;
    player.properties.push(property.id);
    game.state.phase = 'WAITING_TILE_RESOLUTION';
    game.state.lastRoll = {dice: [1, 2], total: 3, isDouble: false, consecutiveDoubles: 0, movementId: 'chance-move'};
    const started = game.resolveLandedTile({playerId: player.playerId, turnId: 1,
      movementId: 'chance-move', resolutionId: `before-${card.id}`});
    assert.equal(started.resolution.kind, 'CHANCE_PRESENTATION', card.id);
    assert.equal(player.money, 1500, `${card.id} cannot change balance before Continue`);
    assert.equal(player.pos, 2, `${card.id} cannot move before Continue`);
    assert.equal(player.hasGetOutOfJailCard, 0, `${card.id} cannot award a card before Continue`);
    assert.equal(game.state.transactions.length, 0, `${card.id} cannot transact before Continue`);
    assert.equal(property.houses, 1, `${card.id} cannot charge repair cost before Continue`);
    assert.equal(game.state.phase, 'CHANCE_PRESENTATION');
  }
});

test('public snapshot contains detached display state without server room membership', () => {
  const serverState = createServerGameState({roomCode: 'JK6MN7', roster: roster(2)});
  const publicSnapshot = serverState.toPublicSnapshot();
  assert.doesNotThrow(() => JSON.stringify(publicSnapshot));
  assert.equal(publicSnapshot.roomCode, 'JK6MN7');
  assert.equal('socketId' in publicSnapshot.players[0], false);
  assert.notEqual(publicSnapshot.players, serverState.state.players);
  publicSnapshot.players[0].money = 2;
  assert.equal(serverState.state.players[0].money, 1500);
});

test('authoritative jail actions charge bail atomically, consume jail cards, and reject replay', () => {
  const game = createServerGameState({roomCode: 'JAIL01', roster: roster(2, 'jail')});
  const player = game.state.players[0];
  player.status = PlayerStatus.IN_JAIL; player.inJail = true; player.pos = 10; player.money = 80; player.jailTurns = 2;
  const paid = game.resolveJailAction({playerId: player.playerId, turnId: game.state.turnId, actionId: 'bail-1', action: 'PAY_BAIL'});
  assert.equal(paid.ok, true);
  assert.equal(player.money, 30);
  assert.equal(player.status, PlayerStatus.ACTIVE);
  assert.equal(player.jailTurns, 0);
  assert.equal(game.state.transactions.at(-1).type, 'BAIL');
  assert.equal(game.state.transactions.at(-1).id, 'tx_jail_action_bail-1');
  assert.equal(game.state.transactions.at(-1).id, 'tx_jail_action_bail-1');
  assert.equal(game.resolveJailAction({playerId: player.playerId, turnId: game.state.turnId, actionId: 'bail-1', action: 'PAY_BAIL'}).ok, false);

  player.status = PlayerStatus.IN_JAIL; player.inJail = true; player.hasGetOutOfJailCard = 1;
  const card = game.resolveJailAction({playerId: player.playerId, turnId: game.state.turnId, actionId: 'card-1', action: 'USE_CARD'});
  assert.equal(card.ok, true);
  assert.equal(player.hasGetOutOfJailCard, 0);
  assert.equal(player.status, PlayerStatus.ACTIVE);
  assert.equal(card.result.snapshot.players[0].hasGetOutOfJailCard, 0);
});

test('authoritative jail actions reject insufficient bail and missing cards without partial changes', () => {
  const game = createServerGameState({roomCode: 'JAIL02', roster: roster(2, 'jail')});
  const player = game.state.players[0];
  player.status = PlayerStatus.IN_JAIL; player.inJail = true; player.money = 49; player.jailTurns = 2;
  const before = game.state.toSnapshot();
  assert.equal(game.resolveJailAction({playerId: player.playerId, turnId: game.state.turnId, actionId: 'poor', action: 'PAY_BAIL'}).error.code, 'INSUFFICIENT_FUNDS');
  assert.equal(game.resolveJailAction({playerId: player.playerId, turnId: game.state.turnId, actionId: 'nocard', action: 'USE_CARD'}).error.code, 'NO_JAIL_CARD');
  assert.equal(player.money, before.players[0].money);
  assert.equal(player.status, PlayerStatus.IN_JAIL);
  assert.equal(player.jailTurns, 2);
  assert.equal(game.state.transactions.length, before.transactions.length);
});

test('jail counters, jail cards, and processed action IDs survive a server snapshot round trip', () => {
  const game = createServerGameState({roomCode: 'JAIL04', roster: roster(2, 'jail')});
  const player = game.state.players[0];
  player.status = PlayerStatus.IN_JAIL; player.inJail = true; player.pos = 10; player.jailTurns = 2;
  player.hasGetOutOfJailCard = 1;
  game.processedJailActionIds.add('already-applied');
  const restored = ServerGameState.fromSnapshot(JSON.parse(JSON.stringify(game.toSnapshot())));
  const recovered = restored.state.players[0];
  assert.equal(recovered.status, PlayerStatus.IN_JAIL);
  assert.equal(recovered.inJail, true);
  assert.equal(recovered.jailTurns, 2);
  assert.equal(recovered.hasGetOutOfJailCard, 1);
  assert.equal(restored.processedJailActionIds.has('already-applied'), true);
});

test('jail roll is server-authoritative and applies classic doubles, failed attempt, and third-attempt bail', () => {
  const game = createServerGameState({roomCode: 'JAIL03', roster: roster(2, 'jail')});
  const player = game.state.players[0];
  player.status = PlayerStatus.IN_JAIL; player.inJail = true; player.pos = 10;
  let result = game.rollDice({playerId: player.playerId, turnId: game.state.turnId, actionId: 'roll-double', diceRoller: () => [3, 3]});
  assert.equal(result.result.jailAttempt, true);
  assert.equal(result.result.phase, 'MOVING');
  assert.equal(player.status, PlayerStatus.ACTIVE);
  assert.equal(player.consecutiveDoubles, 0);
  game.state.properties.get(16).owner = player.playerId;
  const movement = game.moveCurrentPlayer({playerId: player.playerId, turnId: game.state.turnId, movementId: 'jail-double-move'});
  const tile = game.resolveLandedTile({playerId: player.playerId, turnId: game.state.turnId,
    movementId: movement.movement.movementId, resolutionId: 'jail-double-tile'});
  assert.equal(tile.resolution.event.extraRollAllowed, false);
  assert.equal(tile.resolution.event.phase, 'PLAYER_ACTION');
  assert.equal(game.extraRollAvailable, false);

  game.state.phase = 'WAITING_ROLL'; game.state.lastRoll = null; game.state.currentTurn = 0;
  game.state.activePlayerId = player.playerId; game.state.consecutiveDoubles = 0;
  player.status = PlayerStatus.IN_JAIL; player.inJail = true; player.jailTurns = 0; player.money = 100;
  result = game.rollDice({playerId: player.playerId, turnId: game.state.turnId, actionId: 'roll-fail', diceRoller: () => [2, 3]});
  assert.equal(result.result.phase, 'JAIL_ATTEMPT');
  assert.equal(result.result.jailResolution.outcome, 'FAILED');
  assert.equal(player.status, PlayerStatus.IN_JAIL);
  assert.equal(player.jailTurns, 1);
  assert.equal(game.state.currentTurn, 1);

  game.state.currentTurn = 0; game.state.activePlayerId = player.playerId; game.state.turnId++;
  player.jailTurns = 2; player.status = PlayerStatus.IN_JAIL; player.inJail = true;
  game.state.phase = 'WAITING_ROLL'; game.state.gameStatus = GameStatus.IN_GAME;
  result = game.rollDice({playerId: player.playerId, turnId: game.state.turnId, actionId: 'roll-third-fail', diceRoller: () => [1, 2]});
  assert.equal(result.result.jailResolution.outcome, 'FORCED_BAIL');
  assert.equal(player.status, PlayerStatus.ACTIVE);
  assert.equal(player.money, 50);
  assert.equal(game.state.transactions.at(-1).type, 'BAIL');
});

test('first and second doubles require another roll, while the third double sends the player to jail', () => {
  const game = createServerGameState({roomCode: 'DBL001', roster: roster(2, 'double')});
  const player = game.state.players[0];
  game.state.properties.get(3).owner = player.playerId;
  game.state.properties.get(5).owner = player.playerId;
  player.properties.push('prop_3', 'prop_5');

  const finishDouble = (number, dice) => {
    player.pos = 1;
    const roll = game.rollDice({playerId: player.playerId, turnId: game.state.turnId, diceRoller: () => dice});
    assert.equal(roll.ok, true);
    assert.equal(roll.result.consecutiveDoubles, number);
    const movement = game.moveCurrentPlayer({playerId: player.playerId, turnId: game.state.turnId,
      movementId: `double-move-${number}`});
    assert.equal(movement.ok, true);
    const tile = game.resolveLandedTile({playerId: player.playerId, turnId: game.state.turnId,
      movementId: movement.movement.movementId, resolutionId: `double-tile-${number}`});
    assert.equal(tile.ok, true);
    return tile.resolution.event;
  };

  const first = finishDouble(1, [1, 1]);
  assert.equal(first.extraRollAllowed, true);
  assert.equal(game.extraRollAvailable, true);
  assert.equal(game.endTurn({playerId: player.playerId, turnId: game.state.turnId, actionId: 'end-after-double-1'}).error.code,
    'EXTRA_ROLL_REQUIRED');

  const second = finishDouble(2, [2, 2]);
  assert.equal(second.extraRollAllowed, true);
  assert.equal(game.extraRollAvailable, true);
  assert.equal(game.endTurn({playerId: player.playerId, turnId: game.state.turnId, actionId: 'end-after-double-2'}).error.code,
    'EXTRA_ROLL_REQUIRED');

  player.pos = 1;
  const third = game.rollDice({playerId: player.playerId, turnId: game.state.turnId, diceRoller: () => [3, 3]});
  assert.equal(third.result.tripleDouble, true);
  assert.equal(game.extraRollAvailable, false);
  const jailed = game.sendToJailForThirdDouble({playerId: player.playerId, turnId: game.state.turnId,
    resolutionId: 'triple-double-jail'});
  assert.equal(jailed.ok, true);
  assert.equal(player.status, PlayerStatus.IN_JAIL);
  assert.equal(game.state.activePlayerId, game.state.players[1].playerId);
});

test('server rooms use the shared board catalog and own independent initial property records', () => {
  const one = createServerGameState({roomCode: 'AB2CD3', roster: roster(2)});
  const two = createServerGameState({roomCode: 'EF4GH5', roster: roster(2, 'other')});
  const catalogProperties = loadBoardCatalog().TILES.filter(tile => ['prop', 'rail', 'util'].includes(tile.type));
  assert.equal(one.state.properties.size, catalogProperties.length);
  assert.deepEqual([...one.state.properties.keys()], catalogProperties.map(tile => tile.pos));
  assert.notEqual(one.state.properties.get(1), two.state.properties.get(1));
  assert.deepEqual(one.toPublicSnapshot().properties, one.toSnapshot().gameState.properties);
});

test('runtime board contains six Chance tiles and no Community Chest tile', () => {
  const tiles = loadBoardCatalog().TILES;
  assert.deepEqual(tiles.filter(tile => tile.type === 'chance').map(tile => tile.pos), [2, 7, 17, 22, 33, 36]);
  assert.equal(tiles.filter(tile => /community|chest|dana umum/i.test(`${tile.type} ${tile.nama}`)).length, 0);
});

test('each room gets an isolated shuffled Chance deck and jail card stays out until returned', () => {
  const sequence = Array.from({length: 32}, (_, index) => index / 32);
  const first = new ChanceDeck({random: () => sequence.shift() ?? 0});
  const second = new ChanceDeck({random: () => 0.5});
  assert.notEqual(first.activeDeck, second.activeDeck);
  const jail = CHANCE_CARDS.find(card => card.type === 'GET_OUT_OF_JAIL');
  first.activeDeck = [jail];
  first.discardPile = [];
  assert.equal(first.draw().id, jail.id);
  assert.equal(first.discardPile.length, 0);
  first.returnGetOutOfJailCard();
  assert.equal(first.discardPile.length, 1);
  assert.equal(second.discardPile.length, 0);
});

function prepareChanceLanding(card, {money = 1500, isDouble = false, pos = 2, cards = null} = {}) {
  const serverState = createServerGameState({
    roomCode: 'CH2NCE', roster: roster(2, 'chance'), chanceDeck: {draw: () => ({...(cards?.shift() || card)})}
  });
  const player = serverState.state.players[0];
  player.pos = pos;
  player.money = money;
  serverState.state.phase = 'WAITING_TILE_RESOLUTION';
  serverState.state.lastRoll = {dice: isDouble ? [1, 1] : [1, 2], total: isDouble ? 2 : 3, isDouble, consecutiveDoubles: isDouble ? 1 : 0, movementId: 'chance-move'};
  serverState.state.consecutiveDoubles = isDouble ? 1 : 0;
  return {serverState, player, guest: serverState.state.players[1]};
}

function resolveChanceFully(serverState, player, args) {
  const opened = serverState.resolveLandedTile(args);
  if (!opened.ok || opened.resolution?.kind !== 'CHANCE_PRESENTATION') return opened;
  const outcomes = [];
  let pending = opened.resolution.event;
  for (let index = 0; pending && index < 4; index++) {
    const response = serverState.continueChancePresentation({playerId: player.playerId, turnId: pending.turnId,
      resolutionId: pending.resolutionId, presentationId: pending.presentationId,
      actionId: `test-continue-${index}-${pending.presentationId}`});
    if (!response.ok) return response;
    outcomes.push(response.result.resolution);
    pending = response.result.nextPresentation?.event || null;
  }
  return {...opened, resolution: outcomes.at(-1) || opened.resolution, outcomes};
}

test('server-authoritative movement cards resolve their official route and unowned destination offer', () => {
  for (const [cardId, start, end] of [['ch_4', 2, 5], ['ch_5', 2, 24], ['ch_6', 2, 12]]) {
    const card = CHANCE_CARDS.find(item => item.id === cardId);
    const {serverState, player} = prepareChanceLanding(card);
    const result = resolveChanceFully(serverState, player, {playerId: player.playerId, turnId: 1, movementId: 'chance-move', resolutionId: `move-${cardId}`});
    const event = result.resolution.event;
    assert.equal(event.movements[0].startPos, start);
    assert.equal(event.movements[0].endPos, end);
    assert.equal(event.position, end);
    assert.equal(serverState.state.phase, 'WAITING_PROPERTY_DECISION');
    assert.equal(event.destinationOffer.propertyPos, end);
  }
});

test('movement card awards START salary only when passing START, then resolves destination', () => {
  const card = CHANCE_CARDS.find(item => item.id === 'ch_4');
  const {serverState, player} = prepareChanceLanding(card, {pos: 17});
  const result = resolveChanceFully(serverState, player, {playerId: player.playerId, turnId: 1, movementId: 'chance-move', resolutionId: 'move-pass-start'});
  assert.equal(result.resolution.event.movements[0].passedStart, true);
  assert.equal(result.resolution.event.movements[0].startBonus, 200);
  assert.equal(result.resolution.event.transactions.some(tx => tx.type === 'SALARY' && tx.amount === 200), true);
  assert.equal(serverState.state.transactions.some(tx => tx.type === 'SALARY' && tx.amount === 200), true);
  assert.equal(player.money, 1700);
  assert.equal(player.pos, 5);
});

test('backward Chance movement can send player to jail, and a Chance destination draws only one additional card', () => {
  const backward = CHANCE_CARDS.find(item => item.id === 'ch_7');
  const toJail = prepareChanceLanding(backward, {pos: 33});
  const jailed = resolveChanceFully(toJail.serverState, toJail.player, {playerId: toJail.player.playerId, turnId: 1, movementId: 'chance-move', resolutionId: 'move-jail'});
  assert.equal(jailed.resolution.event.movements[0].direction, 'backward');
  assert.equal(jailed.resolution.event.position, 30);
  assert.equal(jailed.resolution.event.destinationResolution, 'TILE_RESOLVED');
  assert.equal(toJail.player.pos, 10);
  assert.equal(toJail.player.inJail, true);

  const second = CHANCE_CARDS.find(item => item.id === 'ch_3');
  const chain = prepareChanceLanding(backward, {pos: 36, cards: [backward, second]});
  const result = resolveChanceFully(chain.serverState, chain.player, {playerId: chain.player.playerId, turnId: 1, movementId: 'chance-move', resolutionId: 'move-chain'});
  assert.deepEqual(result.outcomes.map(item => item.event.card.id), ['ch_7', 'ch_3']);
  assert.equal(result.outcomes[0].event.movements.length, 1);
  assert.equal(result.outcomes[1].event.movements.length, 1);
  assert.equal(result.outcomes[1].event.movements[0].startPos, 33);
  assert.equal(result.outcomes[1].event.movements[0].endPos, 0);
  assert.equal(chain.player.money, 1700);
  assert.equal(chain.player.pos, 0);
  assert.equal(result.resolution.event.destinationResolution, 'TILE_RESOLVED');
});

test('movement card resolving to another player owned property charges authoritative rent', () => {
  const card = CHANCE_CARDS.find(item => item.id === 'ch_6');
  const {serverState, player} = prepareChanceLanding(card);
  serverState.state.properties.get(12).owner = serverState.state.players[1].playerId;
  const result = resolveChanceFully(serverState, player, {playerId: player.playerId, turnId: 1, movementId: 'chance-move', resolutionId: 'move-owned'});
  assert.equal(result.resolution.event.destinationResolution, 'RENT_RESOLVED');
  assert.equal(result.resolution.event.destinationEvent.rent.outcome, 'PAID');
  assert.equal(result.resolution.event.destinationEvent.rent.ownerId, serverState.state.players[1].playerId);
  assert.equal(serverState.state.phase, 'PLAYER_ACTION');
  assert.equal(serverState.state.turnId, 1);
});

test('movement card destination preserves doubles through its property decision and rejects replay', () => {
  const card = CHANCE_CARDS.find(item => item.id === 'ch_6');
  const {serverState, player} = prepareChanceLanding(card, {isDouble: true});
  const args = {playerId: player.playerId, turnId: 1, movementId: 'chance-move', resolutionId: 'move-double'};
  const moved = resolveChanceFully(serverState, player, args);
  assert.equal(moved.resolution.event.destinationResolution, 'PROPERTY_OFFER');
  assert.equal(serverState.resolveLandedTile(args).ok, false);
  const declined = serverState.respondToPropertyOffer({playerId: player.playerId, turnId: 1,
    resolutionId: 'move-double', decision: 'DECLINE'});
  assert.equal(declined.ok, true);
  assert.equal(declined.result.type, 'STARTED');
  const auctionId = declined.result.auction.auctionId;
  serverState.resolveAuctionAction({playerId: player.playerId, turnId: 1, auctionId, actionId: 'double-pass-a', action: 'PASS'});
  const ended = serverState.resolveAuctionAction({playerId: serverState.state.players[1].playerId, turnId: 1,
    auctionId, actionId: 'double-pass-b', action: 'PASS'});
  assert.equal(ended.result.extraRollAllowed, true);
  assert.equal(serverState.state.activePlayerId, player.playerId);
  assert.equal(serverState.state.phase, 'PLAYER_ACTION');
});

test('server resolves and records a Chance reward exactly once and preserves double roll', () => {
  const card = CHANCE_CARDS.find(item => item.id === 'ch_1');
  const {serverState, player} = prepareChanceLanding(card, {isDouble: true});
  const args = {playerId: player.playerId, turnId: 1, movementId: 'chance-move', resolutionId: 'chance-res-1'};
  const result = resolveChanceFully(serverState, player, args);
  assert.equal(result.resolution.kind, 'CHANCE');
  assert.equal(result.resolution.event.card.id, card.id);
  assert.equal(result.resolution.event.supported, true);
  assert.equal(player.money, 1600);
  assert.equal(serverState.state.transactions.length, 1);
  assert.equal(result.resolution.event.extraRollAllowed, true);
  assert.equal(serverState.state.phase, 'PLAYER_ACTION');
  assert.ok(['STALE_TURN', 'STALE_RESOLUTION'].includes(serverState.resolveLandedTile(args).error.code));
  assert.equal(player.money, 1600);
  assert.equal(serverState.state.transactions.length, 1);
});

test('Chance money-loss debt preserves a double roll through snapshot and payment', () => {
  const card = CHANCE_CARDS.find(item => item.id === 'ch_2');
  const {serverState, player} = prepareChanceLanding(card, {money: 10, isDouble: true});
  const result = resolveChanceFully(serverState, player, {playerId: player.playerId, turnId: 1, movementId: 'chance-move', resolutionId: 'chance-debt'});
  assert.equal(result.resolution.event.supported, true);
  assert.equal(result.resolution.event.phase, 'DEBT_RESOLUTION');
  assert.equal(result.resolution.event.debt.chanceCard.id, 'ch_2');
  assert.equal(result.resolution.event.debt.creditorId, 'BANK');
  assert.equal(result.resolution.event.debt.amount, 50);
  assert.equal(player.money, 10);
  assert.equal(serverState.state.turnId, 1);
  assert.equal(serverState.state.phase, 'DEBT_RESOLUTION');
  const restored = ServerGameState.fromSnapshot(JSON.parse(JSON.stringify(serverState.toSnapshot())));
  assert.equal(restored.extraRollAvailable, false, 'the roll is waiting on mandatory debt resolution');
  assert.equal(restored.state.lastRoll.isDouble, true, 'the official completed double survives recovery');
  const restoredPlayer = restored.state.players[0];
  restoredPlayer.money = 50;
  const paid = restored.resolveDebtAction({playerId: restoredPlayer.playerId, turnId: 1,
    debtId: restored.pendingDebt.debtId, actionId: 'chance-pay-2', action: 'PAY'});
  assert.equal(paid.ok, true);
  assert.equal(restoredPlayer.money, 0);
  assert.equal(restored.state.transactions[0].type, 'CARD_PENALTY');
  assert.equal(restored.state.phase, 'PLAYER_ACTION');
  assert.equal(restored.extraRollAvailable, true, 'payment resumes the pending extra-roll right from the saved double');
  assert.equal(restored.pendingChanceResolution, null);
});

test('all Chance bank-penalty cards create correctly referenced debt when funds are short', () => {
  for (const cardId of ['ch_2', 'ch_11', 'ch_13']) {
    const card = CHANCE_CARDS.find(item => item.id === cardId);
    const {serverState, player} = prepareChanceLanding(card, {money: 0});
    const {resolution} = resolveChanceFully(serverState, player, {playerId: player.playerId, turnId: 1,
      movementId: 'chance-move', resolutionId: `debt-${cardId}`});
    assert.equal(resolution.event.debt.amount, 50);
    assert.equal(resolution.event.debt.chanceCard.id, cardId);
    assert.equal(resolution.event.debt.originResolutionId, `debt-${cardId}`);
  }
});

test('Chance repair debts use official house and hotel counts and do not mutate buildings', () => {
  for (const [cardId, expected] of [['ch_8', 2 * 25 + 100], ['ch_9', 2 * 40 + 115]]) {
    const card = CHANCE_CARDS.find(item => item.id === cardId);
    const {serverState, player} = prepareChanceLanding(card, {money: 10});
    const houses = serverState.state.properties.get(1);
    houses.owner = player.playerId; houses.houses = 2;
    const hotel = serverState.state.properties.get(3);
    hotel.owner = player.playerId; hotel.hasHotel = true; hotel.houses = 0;
    const {resolution} = resolveChanceFully(serverState, player, {playerId: player.playerId, turnId: 1,
      movementId: 'chance-move', resolutionId: `repair-${cardId}`});
    assert.equal(resolution.event.debt.amount, expected);
    assert.match(resolution.event.debt.description, /2 rumah, 1 hotel/);
    assert.equal(houses.houses, 2);
    assert.equal(hotel.hasHotel, true);
  }
});

test('Chance ch14 debt has an atomic server recipient list, excludes bankrupt players, and pays once each', () => {
  const card = CHANCE_CARDS.find(item => item.id === 'ch_14');
  const serverState = createServerGameState({roomCode: 'CH2NCE', roster: roster(4, 'chance'),
    chanceDeck: {draw: () => ({...card})}});
  const player = serverState.state.players[0];
  player.pos = 2; player.money = 99;
  serverState.state.players[3].status = PlayerStatus.BANKRUPT;
  serverState.state.phase = 'WAITING_TILE_RESOLUTION';
  serverState.state.lastRoll = {dice: [1, 2], total: 3, isDouble: false, consecutiveDoubles: 0, movementId: 'chance-move'};
  const {resolution} = resolveChanceFully(serverState, player, {playerId: player.playerId, turnId: 1,
    movementId: 'chance-move', resolutionId: 'multi-recipient'});
  assert.equal(resolution.event.debt.amount, 100);
  assert.deepEqual(resolution.event.debt.paymentRecipients.map(item => item.playerId), ['chance-2', 'chance-3']);
  assert.deepEqual(serverState.state.players.map(item => item.money), [99, 1500, 1500, 1500]);
  player.money = 100;
  const paid = serverState.resolveDebtAction({playerId: player.playerId, turnId: 1,
    debtId: serverState.pendingDebt.debtId, actionId: 'multi-pay-once', action: 'PAY'});
  assert.equal(paid.ok, true);
  assert.deepEqual(serverState.state.players.map(item => item.money), [0, 1550, 1550, 1500]);
  assert.equal(serverState.state.transactions.filter(tx => tx.type === 'CARD_PENALTY').length, 2);
  assert.equal(serverState.resolveDebtAction({playerId: player.playerId, turnId: 1,
    debtId: paid.result.debtId, actionId: 'multi-pay-once', action: 'PAY'}).ok, false);
});

test('Chance chain pauses for debt, restores pending context, then completes exactly once', () => {
  const moveBack = CHANCE_CARDS.find(item => item.id === 'ch_7');
  const fee = CHANCE_CARDS.find(item => item.id === 'ch_2');
  const {serverState, player} = prepareChanceLanding(moveBack, {pos: 36, money: 0, cards: [moveBack, fee]});
  const {resolution} = resolveChanceFully(serverState, player, {playerId: player.playerId, turnId: 1,
    movementId: 'chance-move', resolutionId: 'chain-debt'});
  assert.equal(resolution.event.card.id, 'ch_2');
  assert.equal(resolution.event.debt.chanceCard.id, 'ch_2');
  assert.equal(serverState.state.players[0].pos, 33);
  assert.equal(resolution.event.debt.amount, 50);
  assert.equal(serverState.state.phase, 'DEBT_RESOLUTION');
  const restored = ServerGameState.fromSnapshot(JSON.parse(JSON.stringify(serverState.toSnapshot())));
  const restoredPlayer = restored.state.players[0];
  restoredPlayer.money = 50;
  const paid = restored.resolveDebtAction({playerId: restoredPlayer.playerId, turnId: 1,
    debtId: restored.pendingDebt.debtId, actionId: 'chain-pay', action: 'PAY'});
  assert.equal(paid.ok, true);
  assert.equal(paid.result.chanceContinuation.event.kind, 'CHANCE_LIMIT');
  assert.equal(restored.state.phase, 'PLAYER_ACTION');
  assert.equal(restored.state.players[0].pos, 33);
  assert.equal(restored.state.transactions.filter(tx => tx.type === 'CARD_PENALTY').length, 1);
  assert.equal(restored.pendingChanceResolution, null);
});

test('Chance debt can use Stage 5J mortgage liquidation before the Bank is paid', () => {
  const card = CHANCE_CARDS.find(item => item.id === 'ch_11');
  const {serverState, player} = prepareChanceLanding(card, {money: 0});
  const property = serverState.state.properties.get(39);
  property.owner = player.playerId; player.properties.push(property.id);
  const {resolution} = resolveChanceFully(serverState, player, {playerId: player.playerId, turnId: 1,
    movementId: 'chance-move', resolutionId: 'chance-mortgage'});
  const debtId = resolution.event.debt.debtId;
  const mortgage = serverState.resolveDebtAction({playerId: player.playerId, turnId: 1, debtId,
    actionId: 'chance-mortgage-action', action: 'MORTGAGE', propertyPos: 39});
  assert.equal(mortgage.ok, true);
  assert.equal(serverState.pendingDebt.debtId, debtId);
  assert.equal(player.money, 200);
  const paid = serverState.resolveDebtAction({playerId: player.playerId, turnId: 1, debtId,
    actionId: 'chance-mortgage-pay', action: 'PAY'});
  assert.equal(paid.ok, true);
  assert.equal(player.money, 150);
  assert.equal(property.isMortgaged, true);
  assert.deepEqual(serverState.state.transactions.map(tx => tx.type), ['MORTGAGE', 'CARD_PENALTY']);
});

test('Chance repair debt can be settled through the existing Stage 5J building-sale action', () => {
  const card = CHANCE_CARDS.find(item => item.id === 'ch_8');
  const {serverState, player} = prepareChanceLanding(card, {money: 0});
  const property = serverState.state.properties.get(1);
  property.owner = player.playerId; property.houses = 1; property.housePrice = 50;
  serverState.state.bankHouses--;
  player.properties.push(property.id);
  const {resolution} = resolveChanceFully(serverState, player, {playerId: player.playerId, turnId: 1,
    movementId: 'chance-move', resolutionId: 'chance-house-sale'});
  assert.equal(resolution.event.debt.amount, 25);
  const sold = serverState.resolveDebtAction({playerId: player.playerId, turnId: 1,
    debtId: resolution.event.debt.debtId, actionId: 'chance-house-sale-action', action: 'SELL_HOUSE', propertyPos: 1});
  assert.equal(sold.ok, true);
  assert.equal(property.houses, 0);
  assert.equal(player.money, 25);
  const paid = serverState.resolveDebtAction({playerId: player.playerId, turnId: 1,
    debtId: resolution.event.debt.debtId, actionId: 'chance-house-sale-pay', action: 'PAY'});
  assert.equal(paid.ok, true);
  assert.equal(player.money, 0);
  assert.deepEqual(serverState.state.transactions.map(tx => tx.type), ['SELL_BUILD', 'CARD_PENALTY']);
});

test('Chance debt bankruptcy follows the existing Bank route and advances or ends the game once', () => {
  const card = CHANCE_CARDS.find(item => item.id === 'ch_13');
  const {serverState, player} = prepareChanceLanding(card, {money: 0});
  const {resolution} = resolveChanceFully(serverState, player, {playerId: player.playerId, turnId: 1,
    movementId: 'chance-move', resolutionId: 'chance-bankruptcy'});
  const result = serverState.resolveDebtAction({playerId: player.playerId, turnId: 1,
    debtId: resolution.event.debt.debtId, actionId: 'chance-bankruptcy-action', action: 'BANKRUPTCY'});
  assert.equal(result.ok, true);
  assert.equal(result.result.completedDebt.status, 'BANKRUPTCY');
  assert.equal(serverState.state.players[0].status, PlayerStatus.BANKRUPT);
  assert.equal(serverState.state.players[1].money, 1500);
  assert.equal(serverState.state.phase, 'GAME_OVER');
  assert.equal(serverState.state.gameStatus, GameStatus.FINISHED);
  assert.equal(serverState.pendingChanceResolution, null);
});

test('server resolves safe Chance transfers, building costs, and jail-card storage from official state', () => {
  const payCard = CHANCE_CARDS.find(item => item.id === 'ch_14');
  const payment = prepareChanceLanding(payCard);
  const paid = resolveChanceFully(payment.serverState, payment.player, {playerId: payment.player.playerId, turnId: 1, movementId: 'chance-move', resolutionId: 'chance-pay'});
  assert.equal(paid.resolution.event.supported, true);
  assert.deepEqual(payment.serverState.state.players.map(item => item.money), [1450, 1550]);
  assert.equal(paid.resolution.event.transactions[0].amount, 50);

  const collectCard = CHANCE_CARDS.find(item => item.id === 'ch_15');
  const collection = prepareChanceLanding(collectCard);
  collection.serverState.state.players[1].money = 25;
  const collected = resolveChanceFully(collection.serverState, collection.player, {playerId: collection.player.playerId, turnId: 1, movementId: 'chance-move', resolutionId: 'chance-collect'});
  assert.equal(collected.resolution.event.supported, true);
  assert.equal(collection.serverState.state.players[0].money, 1525);
  assert.equal(collection.serverState.state.players[1].money, 0);

  const repairCard = CHANCE_CARDS.find(item => item.id === 'ch_8');
  const repair = prepareChanceLanding(repairCard);
  const owned = repair.serverState.state.properties.get(1);
  owned.owner = repair.player.playerId;
  owned.houses = 2;
  const repaired = resolveChanceFully(repair.serverState, repair.player, {playerId: repair.player.playerId, turnId: 1, movementId: 'chance-move', resolutionId: 'chance-repair'});
  assert.equal(repaired.resolution.event.supported, true);
  assert.equal(repair.player.money, 1450);

  const jailCard = CHANCE_CARDS.find(item => item.id === 'ch_16');
  const jail = prepareChanceLanding(jailCard);
  const stored = resolveChanceFully(jail.serverState, jail.player, {playerId: jail.player.playerId, turnId: 1, movementId: 'chance-move', resolutionId: 'chance-jail-card'});
  assert.equal(stored.resolution.event.supported, true);
  assert.equal(jail.player.hasGetOutOfJailCard, 1);
});

test('Chance card movement to START applies official salary and completes the roll', () => {
  const card = CHANCE_CARDS.find(item => item.id === 'ch_3');
  const {serverState, player} = prepareChanceLanding(card);
  const result = resolveChanceFully(serverState, player, {playerId: player.playerId, turnId: 1, movementId: 'chance-move', resolutionId: 'chance-move-card'});
  assert.equal(result.resolution.event.supported, true);
  assert.equal(result.resolution.event.destinationResolution, 'TILE_RESOLVED');
  assert.equal(player.pos, 0);
  assert.equal(player.money, 1700);
  assert.equal(serverState.state.turnId, 1);
});

test('official movement uses server position and dice, pays START once, and awaits tile resolution', () => {
  const serverState = createServerGameState({roomCode: 'AB2CD3', roster: roster(2, 'move')});
  const player = serverState.state.players[0];
  player.pos = 38;
  const dice = serverState.rollDice({playerId: player.playerId, turnId: 1, diceRoller: () => [1, 1]});
  assert.equal(dice.ok, true);
  const movement = serverState.moveCurrentPlayer({playerId: player.playerId, turnId: 1, movementId: 'move-1'});
  assert.equal(movement.ok, true);
  assert.equal(movement.movement.startPos, 38);
  assert.equal(movement.movement.endPos, 0);
  assert.equal(movement.movement.steps, 2);
  assert.equal(movement.movement.diceTotal, 2);
  assert.equal(movement.movement.passedStart, true);
  assert.equal(movement.movement.startBonus, 200);
  assert.equal(movement.movement.balance, 1700);
  assert.deepEqual(movement.movement.transactions.map(tx => [tx.type, tx.amount]), [['SALARY', 200]]);
  assert.equal(serverState.state.transactions.at(-1).type, 'SALARY');
  assert.equal(player.pos, 0);
  assert.equal(player.money, 1700);
  assert.equal(serverState.state.phase, 'WAITING_TILE_RESOLUTION');
  assert.equal(serverState.moveCurrentPlayer({playerId: player.playerId, turnId: 1, movementId: 'move-2'}).ok, false);
  assert.equal(player.money, 1700);
});

test('movement without crossing START gives no salary', () => {
  const serverState = createServerGameState({roomCode: 'EF4GH5', roster: roster(2, 'no-start')});
  const player = serverState.state.players[0];
  player.pos = 3;
  serverState.rollDice({playerId: player.playerId, turnId: 1, diceRoller: () => [2, 1]});
  const movement = serverState.moveCurrentPlayer({playerId: player.playerId, turnId: 1, movementId: 'move-no-start'});
  assert.equal(movement.movement.endPos, 6);
  assert.equal(movement.movement.passedStart, false);
  assert.equal(movement.movement.startBonus, 0);
  assert.equal(player.money, 1500);
});

function preparePropertyLanding(code = 'AB2CD3', pos = 3) {
  const serverState = createServerGameState({roomCode: code, roster: roster(2, code)});
  const player = serverState.state.players[0];
  player.pos = pos;
  serverState.state.phase = 'WAITING_TILE_RESOLUTION';
  serverState.state.lastRoll = {dice: [1, 2], total: 3, isDouble: false, movementId: 'movement-1'};
  return {serverState, player, guest: serverState.state.players[1]};
}

test('PLAYER_ACTION waits for explicit end turn, saves a double reroll, and prevents duplicate advancement', () => {
  const {serverState, player, guest} = preparePropertyLanding('ENDT01', 3);
  serverState.state.properties.get(3).owner = player.playerId;
  const resolved = serverState.resolveLandedTile({playerId: player.playerId, turnId: 1,
    movementId: 'movement-1', resolutionId: 'end-turn-tile'});
  assert.equal(resolved.resolution.event.phase, 'PLAYER_ACTION');
  assert.equal(serverState.state.activePlayerId, player.playerId);
  assert.equal(serverState.endTurn({playerId: guest.playerId, turnId: 1, actionId: 'end-wrong-player'}).error.code,
    'NOT_ACTIVE_PLAYER');
  assert.equal(serverState.endTurn({playerId: player.playerId, turnId: 2, actionId: 'end-stale-turn'}).error.code,
    'STALE_TURN');
  const ended = serverState.endTurn({playerId: player.playerId, turnId: 1, actionId: 'end-turn-once'});
  assert.equal(ended.ok, true);
  assert.equal(ended.result.activePlayerId, guest.playerId);
  assert.equal(serverState.endTurn({playerId: player.playerId, turnId: 1, actionId: 'end-turn-once'}).result.duplicate, true);
  assert.equal(serverState.state.turnId, 2);

  const doubled = preparePropertyLanding('ENDT02', 3);
  doubled.serverState.state.phase = 'PLAYER_ACTION';
  doubled.serverState.state.turnId = 2;
  doubled.serverState.state.lastRoll = {dice: [2, 2], total: 4, isDouble: true, consecutiveDoubles: 1};
  doubled.serverState.state.players[0].consecutiveDoubles = 1;
  doubled.serverState.state.consecutiveDoubles = 1;
  doubled.serverState.extraRollAvailable = true;
  const restored = ServerGameState.fromSnapshot(JSON.parse(JSON.stringify(doubled.serverState.toSnapshot())));
  assert.equal(restored.toPublicSnapshot().phase, 'PLAYER_ACTION');
  assert.equal(restored.toPublicSnapshot().extraRollAvailable, true);
  const rejectedEnd = doubled.serverState.endTurn({playerId: doubled.player.playerId, turnId: 2, actionId: 'double-opt-out'});
  assert.equal(rejectedEnd.ok, false);
  assert.equal(rejectedEnd.error.code, 'EXTRA_ROLL_REQUIRED');
  assert.equal(doubled.serverState.state.activePlayerId, doubled.player.playerId);
  assert.equal(doubled.serverState.state.turnId, 2);
  assert.equal(restored.rollDice({playerId: doubled.player.playerId, turnId: 2, diceRoller: () => [1, 3]}).ok, true,
    'the server accepts the saved extra roll after reconnect');
  assert.equal(restored.extraRollAvailable, false, 'the right is consumed only when the next roll starts');
});

test('end turn rejects pending decisions and enters game over after the final active player ends', () => {
  const {serverState, player, guest} = preparePropertyLanding('ENDT03');
  serverState.state.phase = 'PLAYER_ACTION';
  for (const field of ['pendingResolution', 'pendingDebt', 'activeAuction', 'pendingChancePresentation', 'pendingFreeParkingDecision']) {
    serverState[field] = field === 'pendingChancePresentation' ? {pendingPlayerIds: [player.playerId]} : {playerId: player.playerId};
    assert.equal(serverState.endTurn({playerId: player.playerId, turnId: 1, actionId: `blocked-${field}`}).error.code,
      'PENDING_ACTION');
    serverState[field] = null;
  }
  guest.status = PlayerStatus.BANKRUPT;
  const finished = serverState.endTurn({playerId: player.playerId, turnId: 1, actionId: 'end-game-turn'});
  assert.equal(finished.ok, true);
  assert.equal(finished.result.phase, 'GAME_OVER');
  assert.equal(finished.result.winner.playerId, player.playerId);
  assert.equal(serverState.endTurn({playerId: player.playerId, turnId: 2, actionId: 'after-game-over'}).error.code,
    'END_TURN_NOT_ALLOWED');

  const trade = preparePropertyLanding('ENDT04');
  trade.serverState.state.phase = 'PLAYER_ACTION';
  trade.serverState.trades.set('trade-independent', {tradeId: 'trade-independent', status: 'PENDING'});
  const tradeTurn = trade.serverState.endTurn({playerId: trade.player.playerId, turnId: 1, actionId: 'end-with-trade-open'});
  assert.equal(tradeTurn.ok, true, 'an independent pending trade does not lock the active turn');
  assert.equal(trade.serverState.trades.get('trade-independent').status, 'PENDING');
});

test('server creates a purchase offer only for the official unowned property at the player position', () => {
  const {serverState, player} = preparePropertyLanding();
  const result = serverState.resolveLandedTile({
    playerId: player.playerId, turnId: 1, movementId: 'movement-1', resolutionId: 'resolution-1'
  });
  assert.equal(result.ok, true);
  assert.equal(result.resolution.kind, 'PROPERTY_OFFER');
  assert.deepEqual(result.resolution.offer, {
    roomCode: 'AB2CD3', playerId: player.playerId, seat: 0, turnId: 1,
    resolutionId: 'resolution-1', propertyPos: 3, propertyId: 'prop_3',
    propertyName: 'Laos', price: 60, balance: 1500, phase: 'WAITING_PROPERTY_DECISION'
  });
  assert.equal(serverState.state.phase, 'WAITING_PROPERTY_DECISION');
  assert.equal(serverState.resolveLandedTile({
    playerId: player.playerId, turnId: 1, movementId: 'movement-1', resolutionId: 'resolution-2'
  }).ok, false);
});

test('server purchase deducts official price, assigns ownership, records once, and advances exactly one turn', () => {
  const {serverState, player, guest} = preparePropertyLanding();
  serverState.resolveLandedTile({playerId: player.playerId, turnId: 1, movementId: 'movement-1', resolutionId: 'resolution-1'});
  const response = serverState.respondToPropertyOffer({
    playerId: player.playerId, turnId: 1, resolutionId: 'resolution-1', decision: 'BUY'
  });
  const property = serverState.state.properties.get(3);
  assert.equal(response.ok, true);
  assert.equal(player.money, 1440);
  assert.equal(property.owner, player.playerId);
  assert.deepEqual(player.properties, ['prop_3']);
  assert.equal(serverState.state.transactions.length, 1);
  assert.equal(serverState.state.transactions[0].type, 'BUY_PROP');
  assert.equal(response.result.turnId, 1);
  assert.equal(response.result.currentTurn, 0);
  assert.equal(response.result.activePlayerId, player.playerId);
  assert.equal(serverState.state.phase, 'PLAYER_ACTION');
  assert.equal(serverState.respondToPropertyOffer({
    playerId: player.playerId, turnId: 1, resolutionId: 'resolution-1', decision: 'BUY'
  }).ok, false);
  assert.equal(player.money, 1440);
  assert.equal(serverState.state.transactions.length, 1);
});

test('decline and insufficient funds never mutate property or balance; decline starts an auction', () => {
  const {serverState, player} = preparePropertyLanding('EF4GH5');
  player.money = 20;
  serverState.resolveLandedTile({playerId: player.playerId, turnId: 1, movementId: 'movement-1', resolutionId: 'resolution-1'});
  const insufficient = serverState.respondToPropertyOffer({
    playerId: player.playerId, turnId: 1, resolutionId: 'resolution-1', decision: 'BUY'
  });
  assert.equal(insufficient.error.code, 'INSUFFICIENT_FUNDS');
  assert.equal(player.money, 20);
  assert.equal(serverState.state.properties.get(3).owner, null);
  assert.equal(serverState.pendingResolution.resolutionId, 'resolution-1');

  const declined = serverState.respondToPropertyOffer({
    playerId: player.playerId, turnId: 1, resolutionId: 'resolution-1', decision: 'DECLINE'
  });
  assert.equal(declined.ok, true);
  assert.equal(player.money, 20);
  assert.equal(serverState.state.properties.get(3).owner, null);
  assert.equal(serverState.state.transactions.length, 0);
  assert.equal(declined.result.type, 'STARTED');
  assert.equal(serverState.state.phase, 'WAITING_AUCTION_ACTION');
  assert.equal(serverState.pendingResolution.resolutionId, 'resolution-1');
  assert.equal(serverState.state.turnId, 1);
});

test('authoritative auction validates actions and settles the highest bid exactly once', () => {
  const {serverState, player, guest} = preparePropertyLanding('AUCT01');
  serverState.resolveLandedTile({playerId: player.playerId, turnId: 1, movementId: 'movement-1', resolutionId: 'resolution-1'});
  const started = serverState.respondToPropertyOffer({playerId: player.playerId, turnId: 1,
    resolutionId: 'resolution-1', decision: 'DECLINE'});
  const auctionId = started.result.auction.auctionId;
  assert.equal(serverState.resolveAuctionAction({playerId: guest.playerId, turnId: 1, auctionId,
    actionId: 'wrong-turn', action: 'BID', bidAmount: 100}).error.code, 'NOT_CURRENT_BIDDER');
  assert.equal(serverState.resolveAuctionAction({playerId: player.playerId, turnId: 1, auctionId,
    actionId: 'negative', action: 'BID', bidAmount: -1}).error.code, 'INVALID_BID');
  assert.equal(serverState.resolveAuctionAction({playerId: player.playerId, turnId: 1, auctionId,
    actionId: 'unaffordable', action: 'BID', bidAmount: 1501}).error.code, 'INSUFFICIENT_FUNDS');
  const first = serverState.resolveAuctionAction({playerId: player.playerId, turnId: 1, auctionId,
    actionId: 'bid-host', action: 'BID', bidAmount: 80});
  assert.equal(first.result.type, 'UPDATED');
  assert.equal(player.money, 1500, 'bids do not debit funds before settlement');
  const second = serverState.resolveAuctionAction({playerId: guest.playerId, turnId: 1, auctionId,
    actionId: 'bid-guest', action: 'BID', bidAmount: 100});
  assert.equal(second.result.type, 'UPDATED');
  const ended = serverState.resolveAuctionAction({playerId: player.playerId, turnId: 1, auctionId,
    actionId: 'pass-host', action: 'PASS'});
  assert.equal(ended.result.type, 'ENDED');
  assert.equal(ended.result.winner.playerId, guest.playerId);
  assert.equal(guest.money, 1400);
  assert.equal(serverState.state.properties.get(3).owner, guest.playerId);
  assert.equal(serverState.state.transactions.filter(tx => tx.type === 'AUCTION').length, 1);
  assert.equal(ended.result.turnId, 1);
  assert.equal(serverState.resolveAuctionAction({playerId: guest.playerId, turnId: 1, auctionId,
    actionId: 'replay', action: 'BID', bidAmount: 120}).error.code, 'AUCTION_NOT_ACTIVE');
});

test('no-bid auction keeps bank ownership and active auction survives snapshot restore', () => {
  const {serverState, player, guest} = preparePropertyLanding('AUCT02');
  serverState.resolveLandedTile({playerId: player.playerId, turnId: 1, movementId: 'movement-1', resolutionId: 'resolution-1'});
  const started = serverState.respondToPropertyOffer({playerId: player.playerId, turnId: 1,
    resolutionId: 'resolution-1', decision: 'DECLINE'});
  const auctionId = started.result.auction.auctionId;
  const restored = ServerGameState.fromSnapshot(serverState.toSnapshot());
  assert.equal(restored.toPublicSnapshot().activeAuction.auctionId, auctionId);
  assert.equal(restored.toPublicSnapshot().pendingPropertyOffer, null);
  restored.resolveAuctionAction({playerId: player.playerId, turnId: 1, auctionId, actionId: 'pass-host', action: 'PASS'});
  const ended = restored.resolveAuctionAction({playerId: guest.playerId, turnId: 1, auctionId, actionId: 'pass-guest', action: 'PASS'});
  assert.equal(ended.result.winner, null);
  assert.equal(restored.state.properties.get(3).owner, null);
  assert.equal(restored.state.transactions.length, 0);
  assert.equal(restored.state.turnId, 1);
});

test('server rejects unauthorized offers and resolves an owned property as rent', () => {
  const {serverState, player, guest} = preparePropertyLanding('JK6MN7');
  serverState.resolveLandedTile({playerId: player.playerId, turnId: 1, movementId: 'movement-1', resolutionId: 'resolution-1'});
  assert.equal(serverState.respondToPropertyOffer({
    playerId: guest.playerId, turnId: 1, resolutionId: 'resolution-1', decision: 'BUY'
  }).error.code, 'NOT_ACTIVE_PLAYER');
  assert.equal(serverState.respondToPropertyOffer({
    playerId: player.playerId, turnId: 0, resolutionId: 'resolution-1', decision: 'BUY'
  }).error.code, 'STALE_TURN');
  assert.equal(serverState.respondToPropertyOffer({
    playerId: player.playerId, turnId: 1, resolutionId: 'old-resolution', decision: 'BUY'
  }).error.code, 'STALE_RESOLUTION');

  serverState.state.properties.get(3).owner = guest.playerId;
  const second = preparePropertyLanding('LM7NP8');
  second.serverState.state.properties.get(3).owner = second.guest.playerId;
  const unsupported = second.serverState.resolveLandedTile({
    playerId: second.player.playerId, turnId: 1, movementId: 'movement-1', resolutionId: 'resolution-2'
  });
  assert.equal(unsupported.resolution.kind, 'RENT_RESOLVED');
  assert.equal(unsupported.resolution.event.rent.outcome, 'PAID');
  assert.equal(second.serverState.state.phase, 'PLAYER_ACTION');
});

test('shared rent rule matches server payments for monopoly, buildings, hotels, stations, and utilities', () => {
  const {serverState, player: tenant, guest: owner} = preparePropertyLanding('RENT01', 3);
  const properties = serverState.state.properties;
  const city = properties.get(3);
  city.owner = owner.playerId;
  let expected = calculatePropertyRent(city, properties, 3);
  let result = serverState.resolveLandedTile({playerId: tenant.playerId, turnId: 1, movementId: 'movement-1', resolutionId: 'rent-base'});
  assert.equal(result.resolution.kind, 'RENT_RESOLVED');
  assert.equal(result.resolution.event.rent.amount, expected);
  assert.equal(tenant.money, 1500 - expected);
  assert.equal(owner.money, 1500 + expected);
  assert.equal(serverState.state.transactions.at(-1).type, 'RENT');

  const monopoly = preparePropertyLanding('RENTMON', 3);
  const monopolyProperty = monopoly.serverState.state.properties.get(3);
  monopolyProperty.owner = monopoly.guest.playerId;
  for (const item of monopoly.serverState.state.properties.values()) {
    if (item.type === 'prop' && item.group === monopolyProperty.group) item.owner = monopoly.guest.playerId;
  }
  expected = calculatePropertyRent(monopolyProperty, monopoly.serverState.state.properties, 3);
  assert.equal(expected, monopolyProperty.rent.base * 2);
  result = monopoly.serverState.resolveLandedTile({playerId: monopoly.player.playerId, turnId: 1, movementId: 'movement-1', resolutionId: 'rent-monopoly'});
  assert.equal(result.resolution.event.rent.amount, expected);

  const houses = preparePropertyLanding('RENTHS', 3);
  const houseCity = houses.serverState.state.properties.get(3);
  houseCity.owner = houses.guest.playerId;
  houseCity.houses = 3;
  expected = calculatePropertyRent(houseCity, houses.serverState.state.properties, 3);
  result = houses.serverState.resolveLandedTile({playerId: houses.player.playerId, turnId: 1, movementId: 'movement-1', resolutionId: 'rent-houses'});
  assert.equal(result.resolution.event.rent.amount, expected);
  assert.equal(expected, houseCity.rent.house3);

  const hotel = preparePropertyLanding('RENTHL', 3);
  const hotelCity = hotel.serverState.state.properties.get(3);
  hotelCity.owner = hotel.guest.playerId;
  hotelCity.hasHotel = true;
  expected = calculatePropertyRent(hotelCity, hotel.serverState.state.properties, 3);
  result = hotel.serverState.resolveLandedTile({playerId: hotel.player.playerId, turnId: 1, movementId: 'movement-1', resolutionId: 'rent-hotel'});
  assert.equal(result.resolution.event.rent.amount, hotelCity.rent.hotel);

  const railSetup = preparePropertyLanding('RENTRR', loadBoardCatalog().TILES.find(tile => tile.type === 'rail').pos);
  const rails = [...railSetup.serverState.state.properties.values()].filter(item => item.type === 'rail');
  rails[0].owner = railSetup.guest.playerId; rails[1].owner = railSetup.guest.playerId; rails[2].owner = railSetup.guest.playerId;
  expected = calculatePropertyRent(rails[0], railSetup.serverState.state.properties, 3);
  result = railSetup.serverState.resolveLandedTile({playerId: railSetup.player.playerId, turnId: 1, movementId: 'movement-1', resolutionId: 'rent-rail'});
  assert.equal(result.resolution.event.rent.amount, rails[0].rent.count3);

  const utilSetup = preparePropertyLanding('RENTUT', loadBoardCatalog().TILES.find(tile => tile.type === 'util').pos);
  const utilities = [...utilSetup.serverState.state.properties.values()].filter(item => item.type === 'util');
  utilities[0].owner = utilSetup.guest.playerId;
  const oneUtility = calculatePropertyRent(utilities[0], utilSetup.serverState.state.properties, 3);
  assert.equal(oneUtility, 12);
  utilities[1].owner = utilSetup.guest.playerId;
  expected = calculatePropertyRent(utilities[0], utilSetup.serverState.state.properties, 3);
  result = utilSetup.serverState.resolveLandedTile({playerId: utilSetup.player.playerId, turnId: 1, movementId: 'movement-1', resolutionId: 'rent-util'});
  assert.equal(result.resolution.event.rent.amount, expected);
  assert.equal(expected, 30);
});

test('self-owned property and mortgaged property never transfer rent', () => {
  const self = preparePropertyLanding('RENTSELF', 3);
  const selfProperty = self.serverState.state.properties.get(3);
  selfProperty.owner = self.player.playerId;
  const ownResult = self.serverState.resolveLandedTile({playerId: self.player.playerId, turnId: 1, movementId: 'movement-1', resolutionId: 'rent-self'});
  assert.equal(ownResult.resolution.event.kind, 'OWN_PROPERTY');
  assert.equal(self.serverState.state.transactions.length, 0);

  const mortgaged = preparePropertyLanding('RENTMORT', 3);
  const property = mortgaged.serverState.state.properties.get(3);
  property.owner = mortgaged.guest.playerId;
  property.isMortgaged = true;
  const result = mortgaged.serverState.resolveLandedTile({playerId: mortgaged.player.playerId, turnId: 1, movementId: 'movement-1', resolutionId: 'rent-mortgaged'});
  assert.equal(result.resolution.kind, 'RENT_RESOLVED');
  assert.equal(result.resolution.event.rent.outcome, 'MORTGAGED');
  assert.equal(result.resolution.event.rent.amount, 0);
  assert.equal(mortgaged.player.money, 1500);
  assert.equal(mortgaged.guest.money, 1500);
  assert.equal(mortgaged.serverState.state.transactions.length, 0);
});

test('insufficient rent never partially transfers, holds the turn, and rejects replay', () => {
  const {serverState, player, guest} = preparePropertyLanding('RENTLOW', 3);
  const property = serverState.state.properties.get(3);
  property.owner = guest.playerId;
  property.hasHotel = true;
  player.money = property.rent.hotel - 1;
  const args = {playerId: player.playerId, turnId: 1, movementId: 'movement-1', resolutionId: 'rent-too-high'};
  const result = serverState.resolveLandedTile(args);
  assert.equal(result.resolution.kind, 'RENT_RESOLVED');
  assert.equal(result.resolution.event.rent.outcome, 'INSUFFICIENT_FUNDS');
  assert.equal(result.resolution.event.phase, 'DEBT_RESOLUTION');
  assert.equal(result.resolution.event.debt.debtType, 'RENT');
  assert.equal(player.money, property.rent.hotel - 1);
  assert.equal(guest.money, 1500);
  assert.equal(serverState.state.turnId, 1);
  assert.equal(serverState.state.transactions.length, 0);
  assert.equal(serverState.resolveLandedTile(args).error.code, 'STALE_RESOLUTION');
});

test('Chance movement resolves rent through the same server rule before broadcasting final balances', () => {
  const card = CHANCE_CARDS.find(item => item.id === 'ch_5');
  const {serverState, player, guest} = prepareChanceLanding(card);
  const property = serverState.state.properties.get(24);
  property.owner = guest.playerId;
  const expected = calculatePropertyRent(property, serverState.state.properties, 3);
  const result = resolveChanceFully(serverState, player, {playerId: player.playerId, turnId: 1, movementId: 'chance-move', resolutionId: 'chance-rent'});
  assert.equal(result.resolution.kind, 'CHANCE');
  assert.equal(result.resolution.event.destinationResolution, 'RENT_RESOLVED');
  assert.equal(result.resolution.event.balances.find(item => item.playerId === player.playerId).money, 1500,
    'Chance movement snapshot precedes rent so clients can apply the rent event once');
  assert.equal(result.resolution.event.destinationEvent.rent.amount, expected);
  assert.equal(player.money, 1500 - expected);
  assert.equal(guest.money, 1500 + expected);
});

function prepareMortgage(pos = 3, code = 'MORT01') {
  const serverGame = createServerGameState({roomCode: code, roster: roster(2, code)});
  const player = serverGame.state.players[0];
  const property = serverGame.state.properties.get(pos);
  property.owner = player.playerId;
  player.properties.push(property.id);
  return {serverGame, player, owner: serverGame.state.players[1], property};
}

test('server mortgage credits the CSV mortgage value for cities, rail stations, and utilities once', () => {
  for (const tile of ['prop', 'rail', 'util'].map(type => loadBoardCatalog().TILES.find(item => item.type === type))) {
    const {serverGame, player, property} = prepareMortgage(tile.pos, `MG${tile.pos}ABC`);
    const value = getMortgageEligibility(property, serverGame.state.properties).value;
    const turnId = serverGame.state.turnId;
    const args = {playerId: player.playerId, turnId, propertyPos: property.pos, resolutionId: `mortgage-${tile.pos}`};
    const result = serverGame.mortgageProperty(args);
    assert.equal(result.ok, true);
    assert.equal(result.result.amount, value);
    assert.equal(property.isMortgaged, true);
    assert.equal(player.money, 1500 + value);
    assert.equal(serverGame.state.transactions.at(-1).type, 'MORTGAGE');
    assert.equal(serverGame.state.turnId, turnId);
    assert.equal(serverGame.mortgageProperty(args).error.code, 'STALE_RESOLUTION');
    assert.equal(player.money, 1500 + value);
  }
});

test('server rejects mortgage by a non-owner, repeat mortgage, and buildings anywhere in the color group', () => {
  const {serverGame, player, owner, property} = prepareMortgage();
  assert.equal(serverGame.mortgageProperty({playerId: owner.playerId, turnId: 1, propertyPos: property.pos, resolutionId: 'other-owner'}).error.code, 'NOT_ACTIVE_PLAYER');
  property.owner = owner.playerId;
  assert.equal(serverGame.mortgageProperty({playerId: player.playerId, turnId: 1, propertyPos: property.pos, resolutionId: 'foreign-property'}).error.code, 'NOT_PROPERTY_OWNER');

  const house = prepareMortgage(3, 'MORT02');
  house.property.houses = 1;
  assert.equal(house.serverGame.mortgageProperty({playerId: house.player.playerId, turnId: 1,
    propertyPos: house.property.pos, resolutionId: 'mortgage-house'}).error.code, 'MORTGAGE_NOT_ALLOWED');

  const hotel = prepareMortgage(3, 'MORT03');
  hotel.property.houses = 0; hotel.property.hasHotel = true;
  assert.equal(hotel.serverGame.mortgageProperty({playerId: hotel.player.playerId, turnId: 1,
    propertyPos: hotel.property.pos, resolutionId: 'mortgage-hotel'}).error.code, 'MORTGAGE_NOT_ALLOWED');

  const group = prepareMortgage(3, 'MORT04');
  const sibling = [...group.serverGame.state.properties.values()].find(item => item.type === 'prop' &&
    item.group === group.property.group && item.pos !== group.property.pos);
  sibling.owner = group.player.playerId; sibling.houses = 1;
  assert.equal(group.serverGame.mortgageProperty({playerId: group.player.playerId, turnId: 1,
    propertyPos: group.property.pos, resolutionId: 'mortgage-group-house'}).error.code, 'MORTGAGE_NOT_ALLOWED');

  const repeated = prepareMortgage(3, 'MORT05');
  repeated.property.isMortgaged = true;
  assert.equal(repeated.serverGame.mortgageProperty({playerId: repeated.player.playerId, turnId: 1,
    propertyPos: repeated.property.pos, resolutionId: 'mortgage-already'}).error.code, 'MORTGAGE_NOT_ALLOWED');
});

test('server redemption charges mortgage value plus rounded ten-percent interest and rejects insufficient funds atomically', () => {
  const {serverGame, player, property} = prepareMortgage(3, 'UNMORT1');
  property.isMortgaged = true;
  const cost = getUnmortgageEligibility(property, serverGame.state.properties, 1500).totalCost;
  const result = serverGame.unmortgageProperty({playerId: player.playerId, turnId: 1,
    propertyPos: property.pos, resolutionId: 'unmortgage-success'});
  assert.equal(result.ok, true);
  assert.equal(result.result.amount, cost);
  assert.equal(property.isMortgaged, false);
  assert.equal(player.money, 1500 - cost);
  assert.equal(serverGame.state.transactions.at(-1).type, 'UNMORTGAGE');

  const poor = prepareMortgage(3, 'UNMORT2');
  poor.property.isMortgaged = true;
  const insufficientCost = getUnmortgageEligibility(poor.property, poor.serverGame.state.properties, 1500).totalCost;
  poor.player.money = insufficientCost - 1;
  const rejected = poor.serverGame.unmortgageProperty({playerId: poor.player.playerId, turnId: 1,
    propertyPos: poor.property.pos, resolutionId: 'unmortgage-poor'});
  assert.equal(rejected.error.code, 'UNMORTGAGE_NOT_ALLOWED');
  assert.equal(poor.property.isMortgaged, true);
  assert.equal(poor.player.money, insufficientCost - 1);
  assert.equal(poor.serverGame.state.transactions.length, 0);
});

test('mortgage actions require the active player, current turn, and WAITING_ROLL phase', () => {
  const {serverGame, player, property} = prepareMortgage();
  assert.equal(serverGame.mortgageProperty({playerId: player.playerId, turnId: 0, propertyPos: property.pos, resolutionId: 'old-turn'}).error.code, 'STALE_TURN');
  serverGame.state.phase = 'WAITING_TILE_RESOLUTION';
  assert.equal(serverGame.mortgageProperty({playerId: player.playerId, turnId: 1, propertyPos: property.pos, resolutionId: 'wrong-phase'}).error.code, 'PROPERTY_ACTION_NOT_ALLOWED');
  assert.equal(property.isMortgaged, false);
  assert.equal(player.money, 1500);
});

function prepareTrade(code = 'TRADE1') {
  const serverGame = createServerGameState({roomCode: code, roster: roster(2, code)});
  const [sender, recipient] = serverGame.state.players;
  const senderProperty = serverGame.state.properties.get(3);
  const recipientProperty = serverGame.state.properties.get(6);
  senderProperty.owner = sender.playerId; sender.properties.push(senderProperty.id);
  recipientProperty.owner = recipient.playerId; recipient.properties.push(recipientProperty.id);
  return {serverGame, sender, recipient, senderProperty, recipientProperty};
}

test('trade offer validates sender, turn, room members, balances, property owners, duplicate assets, and buildings', () => {
  const {serverGame, sender, recipient, senderProperty, recipientProperty} = prepareTrade();
  const base = {playerId: sender.playerId, turnId: 1, actionId: 'create-1', toPlayerId: recipient.playerId,
    offer: {giveMoney: 100, receiveMoney: 50, givePropPositions: [senderProperty.pos],
      receivePropPositions: [recipientProperty.pos], giveJailCards: 0, receiveJailCards: 0}};
  const pending = serverGame.createTradeOffer(base);
  assert.equal(pending.ok, true);
  assert.equal(pending.result.type, 'PENDING');
  assert.equal(serverGame.toPublicSnapshot().trades.length, 0);
  assert.equal(serverGame.toPublicSnapshot({viewerPlayerId: sender.playerId}).trades.length, 1);
  assert.equal(serverGame.toPublicSnapshot({viewerPlayerId: 'unrelated-player'}).trades.length, 0);
  assert.equal(sender.money, 1500);
  assert.equal(recipient.money, 1500);
  assert.equal(senderProperty.owner, sender.playerId);
  assert.equal(serverGame.state.phase, 'WAITING_ROLL');

  assert.equal(serverGame.createTradeOffer({...base, actionId: 'self', toPlayerId: sender.playerId}).error.code, 'SELF_TRADE');
  assert.equal(serverGame.createTradeOffer({...base, actionId: 'other', playerId: recipient.playerId}).error.code, 'NOT_ACTIVE_PLAYER');
  assert.equal(serverGame.createTradeOffer({...base, actionId: 'stale', turnId: 0}).error.code, 'NOT_ACTIVE_PLAYER');
  assert.equal(serverGame.createTradeOffer({...base, actionId: 'negative', offer: {giveMoney: -1}}).error.code, 'INVALID_TRADE_ASSET');
  assert.equal(serverGame.createTradeOffer({...base, actionId: 'too-much', offer: {giveMoney: 1501}}).error.code, 'INSUFFICIENT_FUNDS');
  assert.equal(serverGame.createTradeOffer({...base, actionId: 'duplicate', offer: {givePropPositions: [3, 3]}}).error.code, 'DUPLICATE_ASSET');
  assert.equal(serverGame.createTradeOffer({...base, actionId: 'foreign', offer: {givePropPositions: [6]}}).error.code, 'PROPERTY_NOT_OWNED');
  assert.equal(serverGame.createTradeOffer({...base, actionId: 'bad-receiver', offer: {receivePropPositions: [3]}}).error.code, 'PROPERTY_NOT_OWNED');
  senderProperty.houses = 1;
  assert.equal(serverGame.createTradeOffer({...base, actionId: 'buildings', offer: {givePropPositions: [3]}}).error.code, 'PROPERTY_HAS_BUILDINGS');
});

test('trade acceptance atomically exchanges money, properties, and jail cards once and preserves mortgage', () => {
  const {serverGame, sender, recipient, senderProperty, recipientProperty} = prepareTrade('TRADE2');
  senderProperty.isMortgaged = true;
  sender.hasGetOutOfJailCard = 1;
  recipient.hasGetOutOfJailCard = 2;
  const offer = {giveMoney: 100, receiveMoney: 50, givePropPositions: [3], receivePropPositions: [6],
    giveJailCards: 1, receiveJailCards: 1};
  const created = serverGame.createTradeOffer({playerId: sender.playerId, toPlayerId: recipient.playerId,
    turnId: 1, actionId: 'create-2', offer});
  const accepted = serverGame.resolveTradeAction({playerId: recipient.playerId,
    tradeId: created.result.trade.tradeId, actionId: 'accept-2', action: 'ACCEPT'});
  assert.equal(accepted.ok, true);
  assert.equal(accepted.result.type, 'COMPLETED');
  assert.equal(sender.money, 1450);
  assert.equal(recipient.money, 1550);
  assert.equal(sender.hasGetOutOfJailCard, 1);
  assert.equal(recipient.hasGetOutOfJailCard, 2);
  assert.equal(senderProperty.owner, recipient.playerId);
  assert.equal(recipientProperty.owner, sender.playerId);
  assert.equal(senderProperty.isMortgaged, true);
  assert.equal(serverGame.state.transactions.length, 2);
  assert.equal(serverGame.resolveTradeAction({playerId: recipient.playerId,
    tradeId: created.result.trade.tradeId, actionId: 'accept-2', action: 'ACCEPT'}).result.duplicate, true);
  assert.equal(serverGame.state.transactions.length, 2);
  assert.equal(serverGame.state.phase, 'WAITING_ROLL');
});

test('trade actions enforce receiver/sender authority, terminal status, revalidation, and snapshot recovery', () => {
  const {serverGame, sender, recipient, senderProperty} = prepareTrade('TRADE3');
  const create = offer => serverGame.createTradeOffer({playerId: sender.playerId, toPlayerId: recipient.playerId,
    turnId: 1, actionId: `create-${serverGame.trades.size}`, offer});
  const offer = {giveMoney: 0, receiveMoney: 0, givePropPositions: [3], receivePropPositions: [], giveJailCards: 0, receiveJailCards: 0};
  const first = create(offer).result.trade;
  const restored = ServerGameState.fromSnapshot(JSON.parse(JSON.stringify(serverGame.toSnapshot())));
  assert.equal(restored.toPublicSnapshot({viewerPlayerId: sender.playerId}).trades[0].tradeId, first.tradeId);
  assert.equal(restored.resolveTradeAction({playerId: sender.playerId, tradeId: first.tradeId,
    actionId: 'wrong-accept', action: 'ACCEPT'}).error.code, 'TRADE_ACTION_FORBIDDEN');
  assert.equal(restored.resolveTradeAction({playerId: recipient.playerId, tradeId: first.tradeId,
    actionId: 'wrong-cancel', action: 'CANCEL'}).error.code, 'TRADE_ACTION_FORBIDDEN');
  restored.state.properties.get(3).owner = recipient.playerId;
  const invalid = restored.resolveTradeAction({playerId: recipient.playerId, tradeId: first.tradeId,
    actionId: 'revalidate', action: 'ACCEPT'});
  assert.equal(invalid.result.type, 'INVALIDATED');
  assert.equal(restored.state.transactions.length, 0);
  const second = create(offer).result.trade;
  assert.equal(serverGame.resolveTradeAction({playerId: recipient.playerId, tradeId: second.tradeId,
    actionId: 'reject', action: 'REJECT'}).result.type, 'REJECTED');
  assert.equal(serverGame.resolveTradeAction({playerId: recipient.playerId, tradeId: second.tradeId,
    actionId: 'accept-rejected', action: 'ACCEPT'}).error.code, 'TRADE_NOT_PENDING');
  const third = create(offer).result.trade;
  assert.equal(serverGame.resolveTradeAction({playerId: sender.playerId, tradeId: third.tradeId,
    actionId: 'cancel', action: 'CANCEL'}).result.type, 'CANCELLED');
});

function prepareBuildGroup(code = 'BUILD1') {
  const serverGame = createServerGameState({roomCode: code, roster: roster(2, code)});
  const player = serverGame.state.players[0];
  const group = [...serverGame.state.properties.values()].filter(property => property.type === 'prop' && property.group === 'brown');
  group.forEach(property => { property.owner = player.playerId; player.properties.push(property.id); });
  return {serverGame, player, group};
}

test('authoritative building follows even-build, monopoly, mortgage, balance, and stock rules', () => {
  const {serverGame, player, group} = prepareBuildGroup();
  const [first, second] = group;
  let result = serverGame.resolveBuildingAction({playerId: player.playerId, turnId: 1, actionId: 'build-house-1', action: 'BUILD_HOUSE', propertyPos: first.pos});
  assert.equal(result.ok, true);
  assert.equal(first.houses, 1);
  assert.equal(serverGame.state.bankHouses, 31);
  assert.equal(player.money, 1500 - first.housePrice);
  assert.equal(serverGame.state.transactions.at(-1).type, 'BUILD');
  assert.equal(serverGame.resolveBuildingAction({playerId: player.playerId, turnId: 1, actionId: 'build-house-1', action: 'BUILD_HOUSE', propertyPos: first.pos}).error.code, 'DUPLICATE_ACTION');
  assert.equal(serverGame.resolveBuildingAction({playerId: player.playerId, turnId: 1, actionId: 'uneven', action: 'BUILD_HOUSE', propertyPos: first.pos}).error.code, 'BUILDING_NOT_ALLOWED');
  second.owner = null;
  assert.equal(serverGame.resolveBuildingAction({playerId: player.playerId, turnId: 1, actionId: 'incomplete-group', action: 'BUILD_HOUSE', propertyPos: first.pos}).error.code, 'BUILDING_NOT_ALLOWED');
  assert.equal(serverGame.resolveBuildingAction({playerId: player.playerId, turnId: 1, actionId: 'no-monopoly', action: 'BUILD_HOUSE', propertyPos: second.pos}).error.code, 'NOT_PROPERTY_OWNER');
  second.owner = player.playerId;
  first.isMortgaged = true;
  assert.equal(serverGame.resolveBuildingAction({playerId: player.playerId, turnId: 1, actionId: 'mortgaged', action: 'BUILD_HOUSE', propertyPos: first.pos}).error.code, 'BUILDING_NOT_ALLOWED');
  first.isMortgaged = false;
  player.money = 0;
  assert.equal(serverGame.resolveBuildingAction({playerId: player.playerId, turnId: 1, actionId: 'poor', action: 'BUILD_HOUSE', propertyPos: second.pos}).error.code, 'INSUFFICIENT_FUNDS');
  player.money = 1500;
  serverGame.state.bankHouses = 0;
  assert.equal(serverGame.resolveBuildingAction({playerId: player.playerId, turnId: 1, actionId: 'stock', action: 'BUILD_HOUSE', propertyPos: second.pos}).error.code, 'BUILDING_STOCK_EMPTY');
  assert.equal(second.houses, 0);
});

test('authoritative hotel construction, house/hotel sale, downgrade stock, rent, and mortgage integration', () => {
  const {serverGame, player, group} = prepareBuildGroup('BUILD2');
  const [first, second] = group;
  first.houses = 4; second.houses = 4; serverGame.state.bankHouses -= 8;
  let built = serverGame.resolveBuildingAction({playerId: player.playerId, turnId: 1, actionId: 'hotel-build', action: 'BUILD_HOTEL', propertyPos: first.pos});
  assert.equal(built.ok, true);
  assert.equal(first.hasHotel, true);
  assert.equal(first.houses, 0);
  assert.equal(serverGame.state.bankHouses, 28);
  assert.equal(serverGame.state.bankHotels, 11);
  assert.equal(first.rent.hotel > 0, true);
  assert.equal(getMortgageEligibility(second, serverGame.state.properties).success, false, 'other city cannot be mortgaged while color group has a hotel');
  const soldHotel = serverGame.resolveBuildingAction({playerId: player.playerId, turnId: 1, actionId: 'sell-hotel', action: 'SELL_HOTEL', propertyPos: first.pos});
  assert.equal(soldHotel.ok, true);
  assert.equal(first.hasHotel, false);
  assert.equal(first.houses, 4);
  assert.equal(serverGame.state.bankHouses, 24);
  assert.equal(serverGame.state.bankHotels, 12);
  const soldHouse = serverGame.resolveBuildingAction({playerId: player.playerId, turnId: 1, actionId: 'sell-house', action: 'SELL_HOUSE', propertyPos: first.pos});
  assert.equal(soldHouse.ok, true);
  assert.equal(first.houses, 3);
  assert.equal(serverGame.state.bankHouses, 25);
  assert.equal(serverGame.state.transactions.filter(tx => tx.type === 'SELL_BUILD').length, 2);

  const scarce = prepareBuildGroup('BUILD3');
  const [scarceHotel] = scarce.group;
  scarceHotel.hasHotel = true;
  scarce.serverGame.state.bankHouses = 3;
  scarce.serverGame.state.bankHotels = 11;
  const downgrade = scarce.serverGame.resolveBuildingAction({playerId: scarce.player.playerId, turnId: 1,
    actionId: 'hotel-scarce', action: 'SELL_HOTEL', propertyPos: scarceHotel.pos});
  assert.equal(downgrade.ok, true);
  assert.equal(scarceHotel.houses, 0, 'matches single-player when bank lacks four houses');
  assert.equal(scarce.serverGame.state.bankHouses, 3);

  const noEvenSale = prepareBuildGroup('BUILD4');
  noEvenSale.group[0].houses = 1; noEvenSale.group[1].houses = 2;
  noEvenSale.serverGame.state.bankHouses = 29;
  assert.equal(noEvenSale.serverGame.resolveBuildingAction({playerId: noEvenSale.player.playerId, turnId: 1,
    actionId: 'uneven-sale', action: 'SELL_HOUSE', propertyPos: noEvenSale.group[0].pos}).error.code, 'BUILDING_SALE_NOT_ALLOWED');
});

test('authoritative building action requires active player, current turn, valid phase, and owned city', () => {
  const {serverGame, player, group} = prepareBuildGroup('BUILD5');
  assert.equal(serverGame.resolveBuildingAction({playerId: serverGame.state.players[1].playerId, turnId: 1,
    actionId: 'other-turn', action: 'BUILD_HOUSE', propertyPos: group[0].pos}).error.code, 'NOT_ACTIVE_PLAYER');
  assert.equal(serverGame.resolveBuildingAction({playerId: player.playerId, turnId: 0,
    actionId: 'stale-turn', action: 'BUILD_HOUSE', propertyPos: group[0].pos}).error.code, 'STALE_TURN');
  serverGame.state.phase = 'DEBT_RESOLUTION';
  assert.equal(serverGame.resolveBuildingAction({playerId: player.playerId, turnId: 1,
    actionId: 'wrong-phase', action: 'BUILD_HOUSE', propertyPos: group[0].pos}).error.code, 'BUILDING_ACTION_NOT_ALLOWED');
});

test('known START rule completes server-side while unsupported tile kinds remain explicitly pending', () => {
  const start = preparePropertyLanding('NP8QR9', 0);
  const advanced = start.serverState.resolveLandedTile({
    playerId: start.player.playerId, turnId: 1, movementId: 'movement-1', resolutionId: 'unused'
  });
  assert.equal(advanced.resolution.kind, 'TILE_RESOLVED');
  assert.equal(advanced.resolution.event.kind, 'START');
  assert.equal(advanced.resolution.event.landedPosition, 0);
  assert.equal(advanced.resolution.event.resultingPosition, 0);
  assert.equal(advanced.resolution.event.balance, start.player.money);
  assert.equal(advanced.resolution.event.transaction, null);
  assert.equal(advanced.resolution.event.taxAmount, null);
  assert.equal(start.serverState.state.turnId, 1);
  assert.equal(start.serverState.state.activePlayerId, start.player.playerId);

  const unsupported = preparePropertyLanding('ST9UV2', 2);
  unsupported.serverState.chanceDeck = {draw: () => ({...CHANCE_CARDS.find(card => card.id === 'ch_3')})};
  const pending = unsupported.serverState.resolveLandedTile({
    playerId: unsupported.player.playerId, turnId: 1, movementId: 'movement-1', resolutionId: 'unused'
  });
  assert.equal(pending.resolution.kind, 'CHANCE_PRESENTATION');
  assert.equal(pending.resolution.event.card.id, 'ch_3');
  assert.equal(pending.resolution.event.phase, 'CHANCE_PRESENTATION');
  assert.equal(unsupported.player.money, 1500);
  assert.equal(unsupported.serverState.state.turnId, 1);
  assert.equal(unsupported.serverState.state.phase, 'CHANCE_PRESENTATION');
});

test('tax tiles use board amounts, record one payment, and advance exactly once', () => {
  for (const [pos, amount] of [[4, 200], [38, 100]]) {
    const {serverState, player, guest} = preparePropertyLanding(`TX${pos}ABC`, pos);
    player.money = 500;
    const result = serverState.resolveLandedTile({
      playerId: player.playerId, turnId: 1, movementId: 'movement-1', resolutionId: `tax-${pos}`
    });
    assert.equal(result.resolution.kind, 'TILE_RESOLVED');
    assert.equal(result.resolution.event.taxAmount, amount);
    assert.equal(serverState.state.players[0].money, 500 - amount);
    assert.equal(serverState.state.transactions.length, 1);
    assert.equal(serverState.state.transactions[0].type, 'TAX');
    assert.equal(serverState.state.transactions[0].amount, amount);
    assert.equal(serverState.state.turnId, 1);
    assert.equal(serverState.state.activePlayerId, player.playerId);
    assert.equal(serverState.resolveLandedTile({
      playerId: player.playerId, turnId: 1, movementId: 'movement-1', resolutionId: `tax-${pos}`
    }).error.code, 'TILE_NOT_READY');
    assert.equal(serverState.state.transactions.length, 1);
  }
});

test('insufficient tax balance creates a persistent bank debt and holds the turn', () => {
  const {serverState, player} = preparePropertyLanding('TX4DEF', 4);
  player.money = 30;
  const result = serverState.resolveLandedTile({
    playerId: player.playerId, turnId: 1, movementId: 'movement-1', resolutionId: 'tax-insufficient'
  });
  assert.equal(result.resolution.kind, 'DEBT_CREATED');
  assert.equal(result.resolution.event.debt.debtType, 'TAX');
  assert.equal(result.resolution.event.debt.creditorId, 'BANK');
  assert.equal(serverState.pendingDebt.debtId, result.resolution.event.debt.debtId);
  assert.equal(player.money, 30);
  assert.equal(serverState.state.transactions.length, 0);
  assert.equal(serverState.state.turnId, 1);
  assert.equal(serverState.state.phase, 'DEBT_RESOLUTION');
});

test('pending debts are room-local and survive a server snapshot round trip', () => {
  const roomA = createServerGameState({roomCode: 'DEBTAA', roster: roster(2, 'debtA')});
  const roomB = createServerGameState({roomCode: 'DEBTBB', roster: roster(2, 'debtB')});
  const player = roomA.state.players[0];
  const created = roomA._createDebt({player, turnId: 1, movementId: 'm', resolutionId: 'local-debt',
    debtType: 'TAX', amount: 1000, creditorId: 'BANK', creditorName: 'Bank', position: 4,
    tileName: 'Pajak', description: 'Pajak'});
  assert.equal(roomB.pendingDebt, null);
  const restored = ServerGameState.fromSnapshot(JSON.parse(JSON.stringify(roomA.toSnapshot())));
  assert.equal(restored.pendingDebt.debtId, created.event.debt.debtId);
  assert.equal(restored.toPublicSnapshot().pendingDebt.playerId, player.playerId);
});

test('debt liquidation enforces even house sales, permits mortgage, then pays the bank once', () => {
  const {serverState, player, guest} = preparePropertyLanding('DEBTLIQ', 4);
  player.money = 30;
  for (const pos of [1, 3]) {
    const property = serverState.state.properties.get(pos);
    property.owner = player.playerId;
    player.properties.push(property.id);
  }
  const small = serverState.state.properties.get(1), large = serverState.state.properties.get(3);
  small.houses = 1; large.houses = 2;
  serverState.state.bankHouses -= 3;
  const created = serverState.resolveLandedTile({playerId: player.playerId, turnId: 1, movementId: 'movement-1', resolutionId: 'debt-tax-house'});
  assert.equal(created.resolution.kind, 'DEBT_CREATED');
  const debt = serverState.pendingDebt;
  const earlyPay = serverState.resolveDebtAction({playerId: player.playerId, turnId: 1, debtId: debt.debtId,
    actionId: 'debt-pay-too-early', action: 'PAY'});
  assert.equal(earlyPay.error.code, 'INSUFFICIENT_FUNDS');
  assert.equal(player.money, 30);
  const invalidSale = serverState.resolveDebtAction({playerId: player.playerId, turnId: 1, debtId: debt.debtId,
    actionId: 'debt-sell-invalid', action: 'SELL_HOUSE', propertyPos: 1});
  assert.equal(invalidSale.error.code, 'BUILDING_SALE_NOT_ALLOWED');
  assert.equal(small.houses, 1);

  const soldLarge = serverState.resolveDebtAction({playerId: player.playerId, turnId: 1, debtId: debt.debtId,
    actionId: 'debt-sell-large', action: 'SELL_HOUSE', propertyPos: 3});
  assert.equal(soldLarge.result.type, 'UPDATED');
  assert.equal(large.houses, 1);
  assert.equal(player.money, 55);
  const soldSmall = serverState.resolveDebtAction({playerId: player.playerId, turnId: 1, debtId: debt.debtId,
    actionId: 'debt-sell-small', action: 'SELL_HOUSE', propertyPos: 1});
  assert.equal(soldSmall.result.property.houses, 0);

  const holland = serverState.state.properties.get(39);
  holland.owner = player.playerId; player.properties.push(holland.id);
  const mortgage = serverState.resolveDebtAction({playerId: player.playerId, turnId: 1, debtId: debt.debtId,
    actionId: 'debt-mortgage', action: 'MORTGAGE', propertyPos: 39});
  assert.equal(mortgage.result.property.isMortgaged, true);
  assert.equal(player.money, 280);
  const paid = serverState.resolveDebtAction({playerId: player.playerId, turnId: 1, debtId: debt.debtId,
    actionId: 'debt-pay', action: 'PAY'});
  assert.equal(paid.result.type, 'PAID');
  assert.equal(player.money, 80);
  assert.equal(serverState.pendingDebt, null);
  assert.equal(serverState.completedDebts.at(-1).status, 'PAID');
  assert.equal(serverState.state.transactions.filter(tx => tx.type === 'TAX').length, 1);
  assert.equal(serverState.state.phase, 'PLAYER_ACTION');
  assert.equal(serverState.state.activePlayerId, player.playerId);
  assert.equal(serverState.resolveDebtAction({playerId: player.playerId, turnId: 1, debtId: debt.debtId,
    actionId: 'debt-pay-replay', action: 'PAY'}).ok, false);
});

test('rent debt payment transfers funds to the property owner exactly once', () => {
  const {serverState, player, guest} = preparePropertyLanding('DEBTREN', 3);
  player.money = 10;
  const property = serverState.state.properties.get(3);
  property.owner = guest.playerId;
  const collateral = serverState.state.properties.get(39);
  collateral.owner = player.playerId; player.properties.push(collateral.id);
  const debtResult = serverState._createDebt({player, turnId: 1, movementId: 'movement-1', resolutionId: 'rent-debt',
    debtType: 'RENT', amount: 25, creditorId: guest.playerId, creditorName: guest.name,
    position: property.pos, tileName: property.name, description: `Sewa ${property.name}`});
  const debtId = debtResult.event.debt.debtId;
  const mortgage = serverState.resolveDebtAction({playerId: player.playerId, turnId: 1, debtId,
    actionId: 'rent-debt-mortgage', action: 'MORTGAGE', propertyPos: 39});
  assert.equal(mortgage.ok, true);
  const payment = serverState.resolveDebtAction({playerId: player.playerId, turnId: 1, debtId,
    actionId: 'rent-debt-pay', action: 'PAY'});
  assert.equal(payment.result.type, 'PAID');
  assert.equal(player.money, 185);
  assert.equal(guest.money, 1525);
  assert.deepEqual(payment.result.transaction.players, [player.name, guest.name]);
  assert.equal(payment.result.transaction.type, 'RENT');
  assert.equal(serverState.state.transactions.filter(item => item.id === payment.result.transaction.id).length, 1);
});

test('hotel sale follows bank stock downgrade rules and returns building stock correctly', () => {
  const {serverState, player} = preparePropertyLanding('DEBTHOT', 4);
  player.money = 0;
  const property = serverState.state.properties.get(39);
  property.owner = player.playerId; property.hasHotel = true; player.properties.push(property.id);
  serverState.state.bankHotels--;
  const debt = serverState._createDebt({player, turnId: 1, movementId: 'movement-1', resolutionId: 'hotel-debt',
    debtType: 'TAX', amount: 1000, creditorId: 'BANK', creditorName: 'Bank', position: 4, tileName: 'Tax', description: 'Pajak'});
  assert.equal(debt.kind, 'DEBT_CREATED');
  const result = serverState.resolveDebtAction({playerId: player.playerId, turnId: 1, debtId: debt.event.debt.debtId,
    actionId: 'sell-hotel', action: 'SELL_HOTEL', propertyPos: 39});
  assert.equal(result.result.property.hasHotel, false);
  assert.equal(result.result.property.houses, 4);
  assert.equal(serverState.state.bankHouses, 28);
  assert.equal(serverState.state.bankHotels, 12);
  assert.equal(player.money, 100);
  const restored = ServerGameState.fromSnapshot(JSON.parse(JSON.stringify(serverState.toSnapshot())));
  const replay = restored.resolveDebtAction({playerId: player.playerId, turnId: 1, debtId: debt.event.debt.debtId,
    actionId: 'sell-hotel', action: 'SELL_HOTEL', propertyPos: 39});
  assert.equal(replay.error.code, 'INVALID_DEBT_ACTION');
  assert.equal(restored.state.players[0].money, 100);
});

test('bankruptcy to another player transfers assets, jail card, mortgage, and ends game for last survivor', () => {
  const serverState = createServerGameState({roomCode: 'DEBTBK', roster: roster(3, 'bankrupt')});
  const debtor = serverState.state.players[0], creditor = serverState.state.players[1];
  const pendingTrade = serverState.createTradeOffer({playerId: debtor.playerId, toPlayerId: creditor.playerId,
    turnId: 1, actionId: 'bankruptcy-trade', offer: {giveMoney: 1}});
  assert.equal(pendingTrade.result.type, 'PENDING');
  debtor.money = 5; debtor.hasGetOutOfJailCard = 1;
  const property = serverState.state.properties.get(39);
  property.owner = debtor.playerId; property.isMortgaged = true; debtor.properties.push(property.id);
  const liquidatable = serverState.state.properties.get(37);
  liquidatable.owner = debtor.playerId; debtor.properties.push(liquidatable.id);
  const created = serverState._createDebt({player: debtor, turnId: 1, movementId: 'm', resolutionId: 'bankrupt-rent',
    debtType: 'RENT', amount: 100, creditorId: creditor.playerId, creditorName: creditor.name,
    position: 39, tileName: property.name, description: `Sewa ${property.name}`});
  assert.equal(created.event.debt.canDeclareBankruptcy, false, 'mortgage value leaves funds available to liquidate');
  const premature = serverState.resolveDebtAction({playerId: debtor.playerId, turnId: 1, debtId: created.event.debt.debtId,
    actionId: 'premature-bankruptcy', action: 'BANKRUPTCY'});
  assert.equal(premature.error.code, 'BANKRUPTCY_NOT_ALLOWED');
  liquidatable.isMortgaged = true;
  debtor.money = 0;
  serverState.pendingDebt.amount = 1000;
  const result = serverState.resolveDebtAction({playerId: debtor.playerId, turnId: 1, debtId: created.event.debt.debtId,
    actionId: 'declare-bankruptcy', action: 'BANKRUPTCY'});
  assert.equal(result.ok, true);
  assert.equal(result.result.invalidatedTrades[0].tradeId, pendingTrade.result.trade.tradeId);
  assert.equal(result.result.invalidatedTrades[0].status, 'INVALIDATED');
  assert.equal(debtor.status, PlayerStatus.BANKRUPT);
  assert.equal(property.owner, creditor.playerId);
  assert.equal(property.isMortgaged, true);
  assert.equal(creditor.money, 1462, 'creditor pays the existing rounded mortgage interest when affordable');
  assert.deepEqual(creditor.properties, ['prop_37', 'prop_39']);
  assert.deepEqual(debtor.properties, []);
  assert.equal(creditor.hasGetOutOfJailCard, 1);
  assert.equal(serverState.state.gameStatus, GameStatus.IN_GAME);
  assert.equal(serverState.state.currentTurn, 1);
  assert.equal(serverState.pendingDebt, null);
});

test('bankruptcy to bank releases property and mortgage; one remaining player wins', () => {
  const serverState = createServerGameState({roomCode: 'DEBTWIN', roster: roster(2, 'winner')});
  const debtor = serverState.state.players[0];
  const property = serverState.state.properties.get(39);
  property.owner = debtor.playerId; property.isMortgaged = true; debtor.properties.push(property.id);
  const created = serverState._createDebt({player: debtor, turnId: 1, movementId: 'm', resolutionId: 'bankrupt-tax',
    debtType: 'TAX', amount: 1000, creditorId: 'BANK', creditorName: 'Bank',
    position: 4, tileName: 'Pajak', description: 'Pajak'});
  debtor.money = 0;
  const result = serverState.resolveDebtAction({playerId: debtor.playerId, turnId: 1, debtId: created.event.debt.debtId,
    actionId: 'bankrupt-to-bank', action: 'BANKRUPTCY'});
  assert.equal(result.result.type, 'BANKRUPTCY');
  assert.equal(result.result.winner.playerId, serverState.state.players[1].playerId);
  assert.equal(property.owner, null);
  assert.equal(property.isMortgaged, false);
  assert.equal(serverState.state.players[1].status, PlayerStatus.ACTIVE);
  assert.equal(serverState.state.gameStatus, GameStatus.FINISHED);
  assert.equal(serverState.state.phase, 'GAME_OVER');
});

test('ordinary jail visit does not jail, go-to-jail does, and an imprisoned turn stays safely locked', () => {
  const visiting = preparePropertyLanding('JV1ABC', 10);
  const visitResult = visiting.serverState.resolveLandedTile({
    playerId: visiting.player.playerId, turnId: 1, movementId: 'movement-1', resolutionId: 'jail-visit'
  });
  assert.equal(visitResult.resolution.kind, 'TILE_RESOLVED');
  assert.equal(visitResult.resolution.event.kind, 'JAIL_VISIT');
  assert.equal(visiting.player.status, PlayerStatus.ACTIVE);
  assert.equal(visiting.player.inJail, false);
  assert.equal(visiting.serverState.state.turnId, 1);

  const jailed = preparePropertyLanding('GJ1ABC', 30);
  const jailResult = jailed.serverState.resolveLandedTile({
    playerId: jailed.player.playerId, turnId: 1, movementId: 'movement-1', resolutionId: 'go-jail'
  });
  assert.equal(jailResult.resolution.event.kind, 'JAILED');
  assert.equal(jailed.player.pos, 10);
  assert.equal(jailed.player.status, PlayerStatus.IN_JAIL);
  assert.equal(jailed.player.inJail, true);
  assert.equal(jailed.player.jailTurns, 0);

  jailed.serverState.state.currentTurn = 0;
  jailed.serverState.state.activePlayerId = jailed.player.playerId;
  jailed.serverState.state.turnId = 3;
  jailed.serverState.state.phase = 'WAITING_ROLL';
  const blockedRoll = jailed.serverState.rollDice({
    playerId: jailed.player.playerId, turnId: 3, diceRoller: () => [1, 2]
  });
  assert.equal(blockedRoll.error.code, 'INVALID_JAIL_ACTION');
  assert.equal(jailed.serverState.state.phase, 'WAITING_ROLL');
  assert.equal(jailed.player.pos, 10);
});

test('free parking completes without changing balance or awarding a transaction', () => {
  const {serverState, player, guest} = preparePropertyLanding('FP1ABC', 20);
  player.money = 73;
  const result = serverState.resolveLandedTile({
    playerId: player.playerId, turnId: 1, movementId: 'movement-1', resolutionId: 'free-parking'
  });
  assert.equal(result.resolution.event.kind, 'FREE_PARKING');
  assert.equal(player.money, 73);
  assert.equal(serverState.state.transactions.length, 0);
  assert.equal(serverState.state.turnId, 1);
  assert.equal(serverState.state.activePlayerId, player.playerId);
  assert.match(result.resolution.event.message, /Tidak ada hadiah uang/);
});

test('free parking follows the single-player double exception and ends the roll turn', () => {
  const {serverState, player, guest} = preparePropertyLanding('FP2ABC', 20);
  player.consecutiveDoubles = 1;
  serverState.state.consecutiveDoubles = 1;
  serverState.state.lastRoll.isDouble = true;
  serverState.state.lastRoll.consecutiveDoubles = 1;
  const result = serverState.resolveLandedTile({
    playerId: player.playerId, turnId: 1, movementId: 'movement-1', resolutionId: 'free-parking-double'
  });
  assert.equal(result.resolution.event.extraRollAllowed, false);
  assert.equal(result.resolution.event.consecutiveDoubles, 0);
  assert.equal(result.resolution.event.phase, 'PLAYER_ACTION');
  assert.equal(serverState.state.activePlayerId, player.playerId);
  assert.equal(player.consecutiveDoubles, 0);
});

test('Free Parking travel is required at turn start, charges once, follows clockwise movement, and rewards START', () => {
  const game = createServerGameState({roomCode: 'PARK01', roster: roster(2, 'parking')});
  const player = game.state.players[0], next = game.state.players[1];
  next.pos = 20;
  game.state.phase = 'PLAYER_ACTION';
  assert.equal(game.advanceTurn({playerId: player.playerId, turnId: game.state.turnId}), true);
  assert.deepEqual(game.pendingFreeParkingDecision, {playerId: next.playerId, turnId: game.state.turnId});
  assert.equal(game.rollDice({playerId: next.playerId, turnId: game.state.turnId, diceRoller: () => [1, 1]}).error.code,
    'FREE_PARKING_DECISION_REQUIRED');
  const before = next.money;
  const traveled = game.resolveFreeParkingAction({playerId: next.playerId, turnId: game.state.turnId,
    actionId: 'parking-travel-1', action: 'TRAVEL', targetPos: 1, movementId: 'parking-move-1', resolutionId: 'parking-resolution-1'});
  assert.equal(traveled.ok, true);
  assert.equal(traveled.result.movement.startPos, 20);
  assert.equal(traveled.result.movement.endPos, 1);
  assert.equal(traveled.result.movement.steps, 21);
  assert.equal(traveled.result.movement.passedStart, true);
  assert.equal(traveled.result.movement.startBonus, 200);
  assert.equal(next.money, before - 50 + 200);
  assert.equal(game.state.transactions.filter(tx => tx.type === 'PARKING_TRAVEL').length, 1);
  assert.equal(game.state.transactions.find(tx => tx.type === 'PARKING_TRAVEL').id, 'tx_free_parking_parking-travel-1');
  assert.equal(game.state.transactions.filter(tx => tx.id === 'tx_free_parking_parking-travel-1_start' && tx.type === 'SALARY').length, 1);
  assert.equal(traveled.result.tileResolution.kind, 'PROPERTY_OFFER');
  const recovered = ServerGameState.fromSnapshot(JSON.parse(JSON.stringify(game.toSnapshot())));
  assert.equal(recovered.state.players[1].pos, 1);
  assert.equal(recovered.state.players[1].money, before - 50 + 200);
  assert.equal(recovered.pendingResolution.propertyPos, 1);
  assert.equal(recovered.processedFreeParkingActionIds.has('parking-travel-1'), true);
  assert.equal(game.resolveFreeParkingAction({playerId: next.playerId, turnId: game.state.turnId,
    actionId: 'parking-travel-1', action: 'TRAVEL', targetPos: 1, movementId: 'replay', resolutionId: 'replay'}).ok, false);
});

test('Free Parking stay releases the roll, low funds do not mutate state, and travel does not pass START when target is ahead', () => {
  const game = createServerGameState({roomCode: 'PARK02', roster: roster(2, 'parking')});
  const player = game.state.players[0];
  player.pos = 20; player.money = 49;
  game.pendingFreeParkingDecision = {playerId: player.playerId, turnId: game.state.turnId};
  const rejected = game.resolveFreeParkingAction({playerId: player.playerId, turnId: game.state.turnId,
    actionId: 'parking-poor', action: 'TRAVEL', targetPos: 24, movementId: 'move-poor', resolutionId: 'resolution-poor'});
  assert.equal(rejected.error.code, 'INSUFFICIENT_FUNDS');
  assert.equal(player.money, 49);
  assert.equal(player.pos, 20);
  assert.ok(game.pendingFreeParkingDecision);
  const stay = game.resolveFreeParkingAction({playerId: player.playerId, turnId: game.state.turnId,
    actionId: 'parking-stay', action: 'STAY'});
  assert.equal(stay.ok, true);
  assert.equal(stay.result.outcome, 'STAY');
  assert.equal(game.pendingFreeParkingDecision, null);
  assert.equal(game.rollDice({playerId: player.playerId, turnId: game.state.turnId, diceRoller: () => [1, 2]}).ok, true);

  const second = createServerGameState({roomCode: 'PARK03', roster: roster(2, 'parking')});
  const active = second.state.players[0]; active.pos = 20;
  second.pendingFreeParkingDecision = {playerId: active.playerId, turnId: second.state.turnId};
  const noPass = second.resolveFreeParkingAction({playerId: active.playerId, turnId: second.state.turnId,
    actionId: 'parking-no-start', action: 'TRAVEL', targetPos: 24, movementId: 'parking-move-2', resolutionId: 'parking-resolution-2'});
  assert.equal(noPass.result.movement.passedStart, false);
  assert.equal(noPass.result.movement.startBonus, 0);
  assert.equal(active.money, 1450);
  assert.equal(noPass.result.tileResolution.kind, 'PROPERTY_OFFER');
});

test('Free Parking destination reuses authoritative rent, tax, Chance, jail, and turn-completion resolvers', () => {
  const createPending = roomCode => {
    const game = createServerGameState({roomCode, roster: roster(2, 'parking')});
    const player = game.state.players[0]; player.pos = 20;
    game.pendingFreeParkingDecision = {playerId: player.playerId, turnId: game.state.turnId};
    return {game, player};
  };
  const performTravel = (game, player, targetPos, id) => game.resolveFreeParkingAction({playerId: player.playerId,
    turnId: game.state.turnId, actionId: id, action: 'TRAVEL', targetPos,
    movementId: `${id}-move`, resolutionId: `${id}-tile`});

  const rentCase = createPending('PARK04');
  rentCase.game.state.properties.get(1).owner = rentCase.game.state.players[1].playerId;
  const rent = performTravel(rentCase.game, rentCase.player, 1, 'parking-rent');
  assert.equal(rent.result.tileResolution.kind, 'RENT_RESOLVED');
  const rentAmount = rent.result.tileResolution.event.rent.amount;
  assert.equal(rentCase.game.state.players[1].money, 1500 + rentAmount);
  assert.equal(rentCase.player.money, 1650 - rentAmount);

  const taxCase = createPending('PARK05');
  const tax = performTravel(taxCase.game, taxCase.player, 4, 'parking-tax');
  assert.equal(tax.result.tileResolution.kind, 'TILE_RESOLVED');
  assert.equal(tax.result.tileResolution.event.kind, 'TAX_PAID');
  assert.equal(taxCase.player.money, 1450);

  const chanceCase = createPending('PARK06');
  chanceCase.game.chanceDeck = {draw: () => ({...CHANCE_CARDS.find(card => card.id === 'ch_1')})};
  const chance = performTravel(chanceCase.game, chanceCase.player, 2, 'parking-chance');
  assert.equal(chance.result.tileResolution.kind, 'CHANCE_PRESENTATION');
  assert.equal(chanceCase.player.money, 1650);
  assert.equal(chanceCase.game.state.phase, 'CHANCE_PRESENTATION');

  const jailCase = createPending('PARK07');
  const jail = performTravel(jailCase.game, jailCase.player, 30, 'parking-jail');
  assert.equal(jail.result.tileResolution.kind, 'TILE_RESOLVED');
  assert.equal(jail.result.tileResolution.event.kind, 'JAILED');
  assert.equal(jailCase.player.status, PlayerStatus.IN_JAIL);
  assert.equal(jailCase.player.pos, 10);

  const startCase = createPending('PARK08');
  const start = performTravel(startCase.game, startCase.player, 0, 'parking-start');
  assert.equal(start.result.tileResolution.kind, 'TILE_RESOLVED');
  assert.equal(start.result.tileResolution.event.extraRollAllowed, false);
  assert.equal(startCase.game.state.turnId, 1);
});
