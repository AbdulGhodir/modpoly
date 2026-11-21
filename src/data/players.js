import {gameState, PlayerStatus, GameStatus} from '../logic/GameState.js';
import {TILES} from './tiles.js';

// Pastikan referensi ke tiles tetap ada di gameState
gameState.tiles = TILES;

export const PLAYERS = gameState.players;
export const GAME = gameState;
export {PlayerStatus, GameStatus, gameState};
export {GameState, createGameState} from '../logic/GameState.js';
