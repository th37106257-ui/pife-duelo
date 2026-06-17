import { motion } from 'framer-motion';
import { memo } from 'react';

const sizeClasses = {
  responsive: 'playing-card-responsive',
  small: 'playing-card-small',
  pile: 'playing-card-pile',
};

function Card({
  card,
  faceDown = false,
  selected = false,
  comboHighlighted = false,
  size = 'responsive',
  onClick,
  className = '',
  layout = true,
  interactive = true,
}) {
  const colorClass = card?.color === 'red' ? 'text-red-700' : 'text-zinc-950';
  const sizeClass = sizeClasses[size] ?? sizeClasses.responsive;

  if (faceDown) {
    return <motion.div layout={layout} className={`${sizeClass} card-back ${className}`} />;
  }

  const CardElement = interactive || onClick ? motion.button : motion.div;
  const interactionProps = interactive || onClick
    ? {
        type: 'button',
        onClick,
        whileTap: interactive ? { scale: selected ? 0.985 : 0.972 } : undefined,
      }
    : {};

  return (
    <CardElement
      layout={layout}
      transition={interactive ? { duration: 0.12, ease: [0.22, 1, 0.36, 1] } : { duration: 0 }}
      className={`${sizeClass} ${colorClass} playing-card ${selected ? 'playing-card-selected' : ''} ${comboHighlighted ? 'playing-card-combo' : ''}`}
      {...interactionProps}
    >
      {comboHighlighted ? <span className="combo-marker" aria-hidden="true" /> : null}
      <span className="card-corner card-corner-top">
        {card.rank}
        <span>{card.symbol}</span>
      </span>
      <span className="card-center-symbol">
        <span className="card-main-rank">{card.rank}</span>
        <span className="card-main-suit">{card.symbol}</span>
      </span>
      <span className="card-corner card-corner-bottom">
        {card.rank}
        <span>{card.symbol}</span>
      </span>
    </CardElement>
  );
}

export default memo(Card);
