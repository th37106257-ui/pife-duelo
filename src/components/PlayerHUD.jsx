import { memo } from 'react';
import PlayerStatusBar from './PlayerStatusBar.jsx';

function PlayerHUD({ name = 'VOCE', cardCount = 0, isActive = false, statusLabel, statusTone }) {
  return (
    <PlayerStatusBar
      playerName={name}
      cardCount={cardCount}
      isActive={isActive}
      statusLabel={statusLabel}
      statusTone={statusTone}
    />
  );
}

export default memo(PlayerHUD);
