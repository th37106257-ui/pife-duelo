import { memo } from 'react';
import StatusGlowDot from './StatusGlowDot.jsx';

function PlayerNameBubble({ label = 'JOGADOR', playerName = 'VOCE' }) {
  return (
    <div className="player-name-bubble">
      <div className="player-name-copy">
        <span className="player-name-label">{label}</span>
        <strong className="player-name-text">{playerName}</strong>
      </div>
      <StatusGlowDot />
    </div>
  );
}

export default memo(PlayerNameBubble);
