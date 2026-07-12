import { memo, useMemo } from 'react';
import { detectValidCombinations } from '../game/rules.js';
import CardFan from './CardFan.jsx';
import PlayerHUD from './PlayerHUD.jsx';

function PlayerHand({
  cards,
  selectedCardId,
  onSelectCard,
  isActive,
  entryFromDeck,
  entryFromDiscard,
  incomingCardId,
  canReorder,
  onReorderCard,
  canDiscard,
  onDiscardDragEnd,
  onDiscardDragState,
  onHandDragState,
  winningCardIds,
  comboHighlightedIds: comboHighlightedIdsOverride,
  departingCardId,
  playerName,
  statusLabel,
  statusTone,
}) {
  const cardSignature = cards.map((card) => card.id).join('|');
  const comboHighlightedIds = useMemo(() => {
    if (Array.isArray(comboHighlightedIdsOverride)) {
      return comboHighlightedIdsOverride;
    }
    const { markedCardIds } = detectValidCombinations(cards);
    return markedCardIds;
  }, [cardSignature, cards, comboHighlightedIdsOverride]);

  return (
    <section className={`player-hand-zone ${isActive ? 'player-hand-active' : ''}`}>
      <PlayerHUD
        name={playerName}
        cardCount={cards.length}
        isActive={isActive}
        statusLabel={statusLabel}
        statusTone={statusTone}
      />
      <CardFan
        cards={cards}
        selectedCardId={selectedCardId}
        onSelectCard={onSelectCard}
        isActive={isActive}
        entryFromDeck={entryFromDeck}
        entryFromDiscard={entryFromDiscard}
        incomingCardId={incomingCardId}
        canReorder={canReorder}
        onReorderCard={onReorderCard}
        canDiscard={canDiscard}
        onDiscardDragEnd={onDiscardDragEnd}
        onDiscardDragState={onDiscardDragState}
        onHandDragState={onHandDragState}
        highlightCardIds={winningCardIds}
        comboHighlightedIds={comboHighlightedIds}
        departingCardId={departingCardId}
      />
    </section>
  );
}

export default memo(PlayerHand);
