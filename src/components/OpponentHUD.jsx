import { memo } from 'react';
import PlayerStatusBar from './PlayerStatusBar.jsx';

function OpponentHUD({ name = 'OPONENTE', cardCount = 0, isActive = false, statusLabel, statusTone }) {
  return (
    <PlayerStatusBar
      playerName={name}
      cardCount={cardCount}
      isActive={isActive}
      variant="opponent"
      statusLabel={statusLabel}
      statusTone={statusTone}
    />
  );
}

export default memo(OpponentHUD);
