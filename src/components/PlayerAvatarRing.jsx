import { memo } from 'react';

function PlayerAvatarRing({ avatarUrl, variant = 'player' }) {
  const isOpponent = variant === 'opponent';

  return (
    <div className="player-avatar-main">
      <span className="player-avatar-ring" aria-hidden="true" />
      <span className="player-avatar-inner">
        {avatarUrl ? (
          <img src={avatarUrl} alt="" />
        ) : (
          <span className={`status-avatar-portrait ${isOpponent ? 'status-avatar-opponent' : ''}`} />
        )}
      </span>
    </div>
  );
}

export default memo(PlayerAvatarRing);
