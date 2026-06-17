import { config } from '../config.js';

export function createTurnState({
  currentPlayerId = null,
  turnStartedAt = null,
  turnDurationSeconds = config.TURN_DURATION_SECONDS,
  turnSecondsLeft = turnDurationSeconds,
  isResolvingAction = false,
  canDraw = true,
  canDiscard = false,
  canKnock = false,
} = {}) {
  return {
    currentPlayerId,
    turnStartedAt,
    turnDurationSeconds,
    turnSecondsLeft,
    isResolvingAction,
    canDraw,
    canDiscard,
    canKnock,
  };
}

export default createTurnState;
