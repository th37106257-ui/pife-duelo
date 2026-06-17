import { memo } from 'react';

function PlayerStatusBar({
  playerName = 'VOCE',
  cardCount = 0,
  isActive = false,
  variant = 'player',
  statusLabel,
  statusTone,
}) {
  const isOpponent = variant === 'opponent';
  const label = statusLabel ?? (isOpponent ? 'Adversario' : 'Sua vez');
  const tone = statusTone ?? (isOpponent ? 'opponent' : 'player');

  return (
    <div
      className={`player-status-bar ${isOpponent ? 'player-status-opponent' : 'player-status-self'} ${isActive ? 'is-active' : 'is-inactive'} status-tone-${tone}`}
    >
      <span className="player-status-avatar" aria-hidden="true" />
      <div className="player-status-copy">
        <strong className="player-status-name">{playerName}</strong>
        <span className="player-status-cards">{cardCount} cartas</span>
        <span className="player-status-turn">
          <span className="player-status-dot" aria-hidden="true" />
          <span>{label}</span>
        </span>
      </div>
    </div>
  );
}

export default memo(PlayerStatusBar);
