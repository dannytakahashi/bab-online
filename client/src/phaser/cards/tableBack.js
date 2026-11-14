/**
 * The back the table draws now (owner, 2026-11-13: alternate red and blue
 * between hands): backFrameForHand of GameState's hand number, so every
 * back (opponent fans, the draw for deal's deck, the face-down trump,
 * won-trick stacks and their placeholders) is the current hand's colour,
 * whether drawn by an event, a render (rejoin, spectator join, reload) or
 * a relayout. GameState.handNo moves at the next hand's gameStart (a
 * zero-bid redeal keeps it), so the colour switches with the next deal.
 */
import { getGameState } from '../../state/GameState.js';
import { backFrameForHand } from './cardFaces.js';

/** The atlas frame of the current hand's back ('back-red' / 'back-blue'). */
export function tableBackFrame() {
  return backFrameForHand(getGameState().handNo);
}
