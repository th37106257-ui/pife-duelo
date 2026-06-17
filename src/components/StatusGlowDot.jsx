import { memo } from 'react';

function StatusGlowDot() {
  return <span className="player-status-dot" aria-hidden="true" />;
}

export default memo(StatusGlowDot);
