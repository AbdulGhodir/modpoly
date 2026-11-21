import {createGameState} from './GameStateCore.js';

export {GameState, GameStatus, PlayerStatus, createGameState} from './GameStateCore.js';

// Compatibility singleton remains a browser-side convenience for legacy game systems.
export const gameState = createGameState();
