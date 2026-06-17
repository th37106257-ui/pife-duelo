export default function PlayerAvatar({ variant = 'player', isActive = false }) {
  return (
    <div className={`player-avatar-frame ${variant === 'opponent' ? 'opponent-avatar-frame' : ''} ${isActive ? 'avatar-active' : ''}`}>
      <span className="player-avatar-face" />
      <span className="player-avatar-glasses" />
      <span className="player-avatar-dot" />
    </div>
  );
}
