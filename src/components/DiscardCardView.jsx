import { memo } from 'react';

function DiscardCardView({ card }) {
  if (!card) return null;

  const colorClass = card.color === 'red' ? 'discard-card-red' : 'discard-card-black';

  return (
    <div className={`discard-card-view ${colorClass}`} aria-label={`${card.rank}${card.symbol}`}>
      <span className="discard-card-corner">
        <strong>{card.rank}</strong>
        <span>{card.symbol}</span>
      </span>
      <span className="discard-card-symbol" aria-hidden="true">{card.symbol}</span>
    </div>
  );
}

export default memo(DiscardCardView);
