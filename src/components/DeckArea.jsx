import { AnimatePresence, motion } from 'framer-motion';
import { memo } from 'react';
import Card from './Card.jsx';
import DiscardCardView from './DiscardCardView.jsx';

const backCard = { id: 'deck-back' };

function DeckArea({
  drawCount,
  discardCards,
  canDraw,
  canTapDraw,
  canTakeDiscard,
  onDraw,
  onTakeDiscard,
  lastAction,
  drawRef,
  discardRef,
  discardDropZoneRef,
  canDropDiscard,
  isDragTarget = false,
  isDragOver = false,
  isRecycling = false,
  selectedCardId,
  onDiscardSelected,
}) {
  const topDiscard = discardCards[discardCards.length - 1];
  const canDropSelected = canDropDiscard && Boolean(selectedCardId);
  const canUseDiscardSlot = canTakeDiscard || canDropSelected;
  const isOnlineStableDiscard = lastAction === 'online';
  const handleDiscardSlotClick = () => {
    if (canDropSelected) {
      onDiscardSelected?.(selectedCardId);
      return;
    }

    onTakeDiscard?.();
  };

  return (
    <section className={`deck-area ${isRecycling ? 'deck-area-recycling' : ''} ${isDragTarget ? 'deck-area-dragging' : ''}`} aria-label="Monte e descarte">
      <span className="deck-recycle-effect" aria-hidden="true" />
      <div className="pile-block">
        <motion.button
          ref={drawRef}
          type="button"
          disabled={!canTapDraw}
          onClick={onDraw}
          whileTap={{ scale: canDraw ? 0.985 : 1 }}
          animate={canDraw ? { scale: 1.015 } : { scale: 1 }}
          transition={{ duration: 0.18, ease: [0.22, 1, 0.36, 1] }}
          className={`deck-button ${canDraw ? 'deck-button-ready' : ''}`}
          aria-label="Comprar carta"
        >
          <span className="deck-shadow deck-shadow-one" />
          <span className="deck-shadow deck-shadow-two" />
          <Card card={backCard} faceDown size="pile" />
        </motion.button>
        <span className="pile-chip" aria-label={`${drawCount} cartas no monte`}>
          <span className="pile-icon">+</span>
          <span>{drawCount}</span>
        </span>
      </div>

      <div className="center-marker" aria-hidden="true" />

      <div className="pile-block">
        <span ref={discardDropZoneRef} className="discard-drop-zone" aria-hidden="true" />
        <motion.button
          ref={discardRef}
          type="button"
          disabled={!canUseDiscardSlot}
          onClick={handleDiscardSlotClick}
          whileTap={{ scale: canUseDiscardSlot ? 0.985 : 1 }}
          animate={canUseDiscardSlot ? { scale: 1.015 } : { scale: 1 }}
          transition={{ duration: 0.18, ease: [0.22, 1, 0.36, 1] }}
          className={`discard-button ${canTakeDiscard ? 'discard-button-ready' : ''} ${canDropSelected ? 'discard-button-drop-ready' : ''} ${isDragTarget ? 'discard-button-drag-target' : ''} ${isDragOver ? 'discard-button-drag-over' : ''}`}
          aria-label={canDropSelected ? 'Descartar carta selecionada' : 'Pegar carta do descarte'}
        >
          <div className={`discard-slot ${canDropDiscard ? 'discard-slot-ready' : ''} ${canTakeDiscard ? 'discard-slot-takeable' : ''}`}>
            <AnimatePresence mode="popLayout">
              {topDiscard ? (
                <motion.div
                  key={topDiscard.instanceId ?? topDiscard.id}
                  initial={
                    isOnlineStableDiscard
                      ? { opacity: 1, y: 0, x: 0, rotate: 0, scale: 1 }
                      : lastAction === 'player-discard'
                      ? { opacity: 0, y: 10, x: 0, rotate: 0, scale: 0.98 }
                      : { opacity: 0, y: -18, x: 0, rotate: 0, scale: 0.98 }
                  }
                  animate={{ opacity: 1, y: 0, x: 0, rotate: 0, scale: 1 }}
                  exit={
                    lastAction === 'player-take-discard'
                      ? { opacity: 0, x: -16, y: 36, rotate: 0, scale: 0.98 }
                      : { opacity: 0, scale: 0.85 }
                  }
                  transition={
                    isOnlineStableDiscard
                      ? { duration: 0.01 }
                      : { duration: 0.18, ease: [0.22, 1, 0.36, 1] }
                  }
                >
                  <DiscardCardView card={topDiscard} />
                </motion.div>
              ) : (
                <span className="empty-discard">{isDragOver ? 'soltar' : canDropDiscard ? 'jogar' : 'vazio'}</span>
              )}
            </AnimatePresence>
            {isDragTarget ? (
              <span className="discard-drop-hint">
                {isDragOver ? 'Soltar para descartar' : 'Arraste ate aqui'}
              </span>
            ) : null}
          </div>
        </motion.button>
        <span className="pile-chip" aria-label={`${discardCards.length} cartas no descarte`}>
          <span className="pile-icon">{"\u21E3"}</span>
          <span>{discardCards.length}</span>
        </span>
      </div>
    </section>
  );
}

export default memo(DeckArea);
