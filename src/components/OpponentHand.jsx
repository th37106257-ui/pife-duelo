import { AnimatePresence, motion } from 'framer-motion';
import { memo, useMemo } from 'react';
import CardFan from './CardFan.jsx';
import OpponentHUD from './OpponentHUD.jsx';

function OpponentHand({
  count,
  cardsCount,
  isThinking = false,
  isActive = false,
  isOpponentTurn,
  isDrawing,
  isDiscarding,
  onAnimationComplete,
  playerName,
  statusLabel,
  statusTone,
  thinkingLabel = 'Oponente pensando',
}) {
  const activeTurn = isOpponentTurn ?? isActive;
  const totalCards = cardsCount ?? count ?? 0;
  const cards = useMemo(
    () => Array.from({ length: totalCards }, (_, index) => ({ id: `opponent-back-${index}` })),
    [totalCards],
  );
  const showDrawTravel = Boolean(isDrawing);
  const showDiscardTravel = Boolean(isDiscarding);

  return (
    <section className={`opponent-zone ${activeTurn ? 'opponent-zone-active' : ''}`}>
      <OpponentHUD
        name={playerName}
        cardCount={totalCards}
        isActive={activeTurn}
        isThinking={isThinking}
        statusLabel={statusLabel}
        statusTone={statusTone}
      />
      {isThinking ? (
        <span className="bot-thinking-indicator">
          {thinkingLabel}<span>.</span><span>.</span><span>.</span>
        </span>
      ) : null}

      <div className="opponent-hand-stage">
        <AnimatePresence>
          {showDrawTravel ? (
            <motion.div
              key="opponent-draw-travel"
              className="opponent-card-flight opponent-card-flight-draw"
              initial={{ opacity: 0, x: 10, y: 112, scale: 0.68, rotate: -8 }}
              animate={{
                opacity: [0, 1, 1, 0],
                x: [10, 7, 2, 0],
                y: [112, 70, 32, 12],
                scale: [0.68, 0.76, 0.86, 0.92],
                rotate: [-8, -5, -2, 0],
              }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.52, ease: [0.22, 1, 0.36, 1] }}
            />
          ) : null}

          {showDiscardTravel ? (
            <motion.div
              key="opponent-discard-travel"
              className="opponent-card-flight opponent-card-flight-discard"
              initial={{ opacity: 0, x: 0, y: 12, scale: 0.86, rotate: 1 }}
              animate={{
                opacity: [0, 1, 1, 0],
                x: [0, 5, 16, 28],
                y: [12, 32, 76, 124],
                scale: [0.86, 0.82, 0.74, 0.65],
                rotate: [1, 5, 9, 13],
              }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.56, delay: 0.54, ease: [0.22, 1, 0.36, 1] }}
              onAnimationComplete={onAnimationComplete}
            />
          ) : null}
        </AnimatePresence>

        <CardFan
          cards={cards}
          faceDown
          variant="opponent"
          isActive={activeTurn}
          isThinking={isThinking}
        />
      </div>
    </section>
  );
}

export default memo(OpponentHand);
