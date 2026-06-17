import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import AudioToggle from './AudioToggle.jsx';
import BeatButton from './BeatButton.jsx';
import CardFlightLayer from './CardFlightLayer.jsx';
import DeckArea from './DeckArea.jsx';
import EndGameReveal from './EndGameReveal.jsx';
import GameModal from './GameModal.jsx';
import OpponentHand from './OpponentHand.jsx';
import PlayerHand from './PlayerHand.jsx';
import Timer from './Timer.jsx';
import {
  discardCardOnline,
  drawFromDeckOnline,
  drawFromDiscardOnline,
  knockOnline,
  reorderHandOnline,
  surrenderOnlineMatch,
} from '../services/onlineGameSocket.js';
import { playSoundEffect } from '../services/soundEffects.js';
import { formatMoney } from '../shared/economy.js';
import { validatePifeHand } from '../shared/pifeRules.js';

function buildOnlineResult(onlineGameState) {
  if (!onlineGameState?.result) return null;

  const won = onlineGameState.result.winnerId === onlineGameState.playerId;
  const economy = onlineGameState.result.economy ?? onlineGameState.economy ?? null;
  const economicResult = onlineGameState.result.economicResult ?? onlineGameState.economicResult ?? null;
  if (onlineGameState.result.reason === 'timeout') {
    return {
      type: won ? 'win' : 'loss',
      winner: onlineGameState.result.winnerId,
      title: '\u23f0 Tempo esgotado',
      emblem: '\u23f0',
      economy,
      economicResult,
      message: won
        ? 'O adversario perdeu por nao realizar uma jogada dentro de 60 segundos.'
        : 'Voce perdeu por nao realizar uma jogada dentro de 60 segundos.',
    };
  }

  return {
    type: won ? 'win' : 'loss',
    winner: onlineGameState.result.winnerId,
    economy,
    economicResult,
    message: won ? 'Voce venceu a partida online.' : 'O adversario venceu a partida online.',
  };
}

function syncOnlineVisualHand(currentHand, serverHand) {
  const serverCardsById = new Map(serverHand.map((card) => [card.id, card]));
  const keptCards = currentHand
    .filter((card) => serverCardsById.has(card.id))
    .map((card) => serverCardsById.get(card.id));
  const keptIds = new Set(keptCards.map((card) => card.id));
  const newCards = serverHand.filter((card) => !keptIds.has(card.id));

  return [...keptCards, ...newCards];
}

function getElementCenter(element) {
  const rect = element?.getBoundingClientRect?.();
  if (!rect) return null;

  return {
    x: rect.left + rect.width / 2,
    y: rect.top + rect.height / 2,
    width: rect.width,
    height: rect.height,
  };
}

function buildOnlineFlight(card, from, to, kind = 'discard') {
  if (!card || !from || !to) return null;

  return {
    id: `online-${kind}-${card.id}-${Date.now()}`,
    kind,
    card,
    from,
    to,
    mid: {
      x: (from.x + to.x) / 2,
      y: kind === 'discard'
        ? (from.y + to.y) / 2 - 6
        : Math.min(from.y, to.y) - 28,
    },
    fromRotate: 0,
    midRotate: kind === 'discard' ? 0 : 3,
    toRotate: kind === 'discard' ? 0.8 : 0,
    fromScale: 1,
    midScale: kind === 'discard' ? 1 : 1.04,
    toScale: kind === 'discard'
      ? 1
      : Math.max(0.54, Math.min(1, to.width / Math.max(from.width, 1))),
    finalScale: kind === 'discard'
      ? Math.max(0.64, Math.min(0.92, to.width / Math.max(from.width, 1)))
      : Math.max(0.54, Math.min(1, to.width / Math.max(from.width, 1))),
    duration: kind === 'discard' ? 0.28 : 0.2,
  };
}

function formatHistoryCard(card) {
  if (!card) return 'carta';
  return `${card.rank ?? ''}${card.symbol ?? ''}`.trim() || 'carta';
}

function formatMatchLogEntry(entry, currentPlayerId) {
  const actor = entry.playerId === currentPlayerId ? 'Voce' : entry.playerId ? 'Oponente' : 'Servidor';
  const source = entry.payload?.source;
  const cardLabel = formatHistoryCard(entry.payload?.card);

  if (!entry.accepted) {
    return `${actor}: acao rejeitada (${entry.reasonIfRejected || 'erro'})`;
  }

  switch (entry.action) {
    case 'playerDrawFromDeck':
      return `${actor} comprou do monte`;
    case 'playerDrawFromDiscard':
      return `${actor} comprou do descarte`;
    case 'playerDiscardCard':
      return `${actor} descartou ${cardLabel}`;
    case 'playerKnock':
      return `${actor} bateu`;
    case 'timeout_started':
      return `${actor}: tempo esgotado`;
    case 'auto_draw_from_deck':
      return `${actor} comprou automaticamente`;
    case 'auto_discard':
      return `${actor} descartou ${cardLabel} automaticamente`;
    case 'auto_turn_player_had_winning_hand':
      return `${actor} tinha jogo, mas nao bateu no timeout`;
    case 'auto_turn_completed':
      return 'Tempo esgotado. Jogada automatica realizada.';
    case 'player_surrender':
      return `${actor} saiu da partida`;
    case 'timeout':
      return `${actor}: tempo esgotado`;
    case 'disconnect_loss':
      return `${actor} perdeu por desconexao`;
    case 'disconnected':
      return `${actor} desconectou`;
    case 'reconnected':
      return `${actor} reconectou`;
    case 'integrity_failed':
      return 'Partida pausada por erro de integridade';
    case 'admin_end_match':
      return 'Partida encerrada pelo suporte';
    case 'admin_force_winner':
      return 'Resultado definido pelo suporte';
    default:
      if (source === 'deck') return `${actor} comprou do monte`;
      if (source === 'discard') return `${actor} comprou do descarte`;
      return `${actor}: ${entry.action}`;
  }
}

function formatHistoryTime(value) {
  if (!value) return '';
  return new Intl.DateTimeFormat('pt-BR', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).format(new Date(value));
}

export default function OnlineGameTable({ onlineGameState, actionError, onLeaveOnline }) {
  const tableRef = useRef(null);
  const drawRef = useRef(null);
  const discardRef = useRef(null);
  const discardDropZoneRef = useRef(null);
  const [selectedCardId, setSelectedCardId] = useState(null);
  const [dragDiscardState, setDragDiscardState] = useState({ active: false, over: false });
  const [handDragging, setHandDragging] = useState(false);
  const [onlineVisualHand, setOnlineVisualHand] = useState(() => onlineGameState.hand ?? []);
  const [onlineFlight, setOnlineFlight] = useState(null);
  const [departingCardId, setDepartingCardId] = useState(null);
  const [incomingCardId, setIncomingCardId] = useState(null);
  const [incomingSource, setIncomingSource] = useState(null);
  const [isAnimatingAction, setIsAnimatingAction] = useState(false);
  const [menuMode, setMenuMode] = useState(null);
  const [visualTopDiscardCard, setVisualTopDiscardCard] = useState(() => onlineGameState.topDiscardCard);
  const [localActionError, setLocalActionError] = useState('');
  const pendingServerHandRef = useRef(null);
  const pendingTopDiscardRef = useRef(undefined);
  const actionAnimationTimeoutRef = useRef(null);
  const incomingTimeoutRef = useRef(null);
  const previousTurnRef = useRef(Boolean(onlineGameState.isYourTurn));
  const alertTurnRef = useRef(null);
  const resultSoundRef = useRef(null);
  const serverHand = onlineGameState.hand ?? [];
  const serverHandSignature = serverHand.map((card) => card.id).join('|');
  const hand = onlineVisualHand;
  const handSignature = hand.map((card) => card.id).join('|');
  const handValidation = useMemo(() => validatePifeHand(hand), [handSignature, hand]);
  const topDiscardCard = onlineGameState.topDiscardCard;
  const displayTopDiscardCard = visualTopDiscardCard;
  const displayedActionError = localActionError || actionError;
  const hasDrawn = Boolean(onlineGameState.hasDrawnThisTurn);
  const isPlaying = onlineGameState.status === 'playing';
  const canAct = onlineGameState.isYourTurn && isPlaying && !handDragging && !isAnimatingAction && !onlineGameState.isResolvingAction;
  const canResolveDrop = onlineGameState.isYourTurn && isPlaying && !isAnimatingAction && !onlineGameState.isResolvingAction;
  const canDraw = canAct && !hasDrawn && (onlineGameState.deckCount > 0 || onlineGameState.canRecycleDrawPile);
  const canTakeDiscard = canAct && !hasDrawn && Boolean(topDiscardCard);
  const canDiscard = canResolveDrop && hasDrawn && hand.length >= 10;
  const canBeat = handValidation.canBeat && canAct;
  const result = buildOnlineResult(onlineGameState);
  const showKnockReveal = onlineGameState.result?.reason === 'knock';
  const turnDurationSeconds = onlineGameState.turnDurationSeconds ?? 60;
  const secondsLeft = Math.max(0, onlineGameState.turnSecondsLeft ?? turnDurationSeconds);
  const playerTurnStatus = onlineGameState.isYourTurn ? 'Sua vez' : 'Aguarde';
  const opponentTurnStatus = onlineGameState.isYourTurn ? 'Aguarde' : 'Adversario';
  const playerStatusTone = onlineGameState.isYourTurn ? 'player' : 'muted';
  const opponentStatusTone = onlineGameState.isYourTurn ? 'muted' : 'opponent';
  const turnLabel = onlineGameState.isYourTurn ? 'Sua vez' : 'Vez do adversario';
  const economy = onlineGameState.economy;

  const actionPayload = {
    roomId: onlineGameState.roomId,
    matchId: onlineGameState.matchId,
    playerId: onlineGameState.playerId,
  };

  const applyHandUpdate = useCallback((newHandOrUpdater) => {
    setOnlineVisualHand((currentHand) => {
      const nextHand = typeof newHandOrUpdater === 'function'
        ? newHandOrUpdater(currentHand)
        : newHandOrUpdater;
      const safeNextHand = Array.isArray(nextHand) ? nextHand : currentHand;
      return safeNextHand;
    });
  }, []);

  const reconcileVisualHand = useCallback((nextServerHand) => {
    applyHandUpdate((currentHand) => {
      const nextHand = syncOnlineVisualHand(currentHand, nextServerHand);
      const currentIds = new Set(currentHand.map((card) => card.id));
      const newCard = nextHand.find((card) => !currentIds.has(card.id));

      if (newCard) {
        setIncomingCardId(newCard.id);
        if (incomingTimeoutRef.current) {
          window.clearTimeout(incomingTimeoutRef.current);
        }
        incomingTimeoutRef.current = window.setTimeout(() => {
          setIncomingCardId(null);
          setIncomingSource(null);
          incomingTimeoutRef.current = null;
        }, 260);
      }

      return nextHand;
    });
    setSelectedCardId((current) => (nextServerHand.some((card) => card.id === current) ? current : null));
  }, [applyHandUpdate]);

  const finishOnlineAnimation = useCallback(() => {
    if (actionAnimationTimeoutRef.current) {
      window.clearTimeout(actionAnimationTimeoutRef.current);
      actionAnimationTimeoutRef.current = null;
    }

    setOnlineFlight(null);
    setDepartingCardId(null);
    setIsAnimatingAction(false);

    if (pendingServerHandRef.current) {
      const pendingHand = pendingServerHandRef.current;
      pendingServerHandRef.current = null;
      reconcileVisualHand(pendingHand);
    }

    if (pendingTopDiscardRef.current !== undefined) {
      setVisualTopDiscardCard(pendingTopDiscardRef.current);
      pendingTopDiscardRef.current = undefined;
    }
  }, [reconcileVisualHand]);

  useEffect(() => {
    if (isAnimatingAction) {
      pendingServerHandRef.current = serverHand;
      return;
    }

    reconcileVisualHand(serverHand);
  }, [isAnimatingAction, reconcileVisualHand, serverHandSignature]);

  useEffect(() => {
    if (isAnimatingAction) {
      pendingTopDiscardRef.current = topDiscardCard;
      return;
    }

    setVisualTopDiscardCard(topDiscardCard);
  }, [isAnimatingAction, topDiscardCard]);

  useEffect(() => {
    if (!displayedActionError) return;

    pendingServerHandRef.current = null;
    setOnlineFlight(null);
    setDepartingCardId(null);
    setIncomingCardId(null);
    setIncomingSource(null);
    setIsAnimatingAction(false);
    pendingTopDiscardRef.current = undefined;
    setVisualTopDiscardCard(topDiscardCard);
    reconcileVisualHand(serverHand);
  }, [displayedActionError, reconcileVisualHand, serverHandSignature, topDiscardCard]);

  useEffect(() => {
    const isYourTurn = Boolean(onlineGameState.isYourTurn && isPlaying);
    if (isYourTurn && !previousTurnRef.current) {
      playSoundEffect('turn');
    }
    previousTurnRef.current = isYourTurn;
  }, [isPlaying, onlineGameState.isYourTurn, onlineGameState.turnNumber]);

  useEffect(() => {
    if (!onlineGameState.isYourTurn || !isPlaying || secondsLeft > 10 || secondsLeft <= 0) return;

    const alertKey = `${onlineGameState.matchId}-${onlineGameState.turnNumber}-${onlineGameState.currentTurnPlayerId}`;
    if (alertTurnRef.current === alertKey) return;

    alertTurnRef.current = alertKey;
    playSoundEffect('alert');
  }, [
    isPlaying,
    onlineGameState.currentTurnPlayerId,
    onlineGameState.isYourTurn,
    onlineGameState.matchId,
    onlineGameState.turnNumber,
    secondsLeft,
  ]);

  useEffect(() => {
    if (!onlineGameState.result) return;

    const resultKey = `${onlineGameState.matchId}-${onlineGameState.result.reason}-${onlineGameState.result.winnerId}`;
    if (resultSoundRef.current === resultKey) return;

    resultSoundRef.current = resultKey;
    playSoundEffect(onlineGameState.result.winnerId === onlineGameState.playerId ? 'win' : 'loss');
  }, [onlineGameState.matchId, onlineGameState.playerId, onlineGameState.result]);

  useEffect(() => () => {
    if (actionAnimationTimeoutRef.current) {
      window.clearTimeout(actionAnimationTimeoutRef.current);
    }
    if (incomingTimeoutRef.current) {
      window.clearTimeout(incomingTimeoutRef.current);
    }
  }, []);

  const isPointInsideDiscard = useCallback((point) => {
    const bounds = discardDropZoneRef.current?.getBoundingClientRect?.()
      ?? discardRef.current?.getBoundingClientRect?.();
    if (!bounds || !point) return false;

    return (
      point.x >= bounds.left &&
      point.x <= bounds.right &&
      point.y >= bounds.top &&
      point.y <= bounds.bottom
    );
  }, []);

  const handleDiscard = useCallback((cardId, originPoint = null) => {
    if (!canDiscard || !cardId) return;
    const card = hand.find((item) => item.id === cardId);
    const cardBox = getElementCenter(tableRef.current?.querySelector(`[data-card-id="${cardId}"]`));
    const from = originPoint && cardBox
      ? { ...cardBox, x: originPoint.x, y: originPoint.y }
      : cardBox;
    const to = getElementCenter(discardRef.current);
    const flight = buildOnlineFlight(card, from, to, 'discard');

    setIsAnimatingAction(true);
    setDepartingCardId(cardId);
    if (flight) setOnlineFlight(flight);
    playSoundEffect('discard');
    pendingServerHandRef.current = hand.filter((item) => item.id !== cardId);
    discardCardOnline({ ...actionPayload, cardId });
    setSelectedCardId(null);
    setDragDiscardState({ active: false, over: false });

    actionAnimationTimeoutRef.current = window.setTimeout(finishOnlineAnimation, 320);
  }, [actionPayload, canDiscard, finishOnlineAnimation, hand]);

  const handleKnock = useCallback(() => {
    if (!onlineGameState.isYourTurn) {
      setLocalActionError('Aguarde sua vez');
      if (incomingTimeoutRef.current) window.clearTimeout(incomingTimeoutRef.current);
      incomingTimeoutRef.current = window.setTimeout(() => setLocalActionError(''), 1600);
      return;
    }

    if (!isPlaying || handDragging || isAnimatingAction || onlineGameState.isResolvingAction) return;

    const analysis = validatePifeHand(hand);

    if (!analysis.canBeat) {
      setLocalActionError('Voce ainda nao pode bater');
      if (incomingTimeoutRef.current) window.clearTimeout(incomingTimeoutRef.current);
      incomingTimeoutRef.current = window.setTimeout(() => setLocalActionError(''), 1600);
      return;
    }

    knockOnline({
      ...actionPayload,
      clientHandOrder: hand.map((card) => card.id),
    });
    playSoundEffect('beat');
  }, [
    actionPayload,
    hand,
    handDragging,
    isAnimatingAction,
    isPlaying,
    onlineGameState.isResolvingAction,
    onlineGameState.isYourTurn,
  ]);

  const handleDiscardDragEnd = useCallback((cardId, point) => {
    if (!isPointInsideDiscard(point)) {
      setDragDiscardState({ active: false, over: false });
      return;
    }

    handleDiscard(cardId, point);
  }, [handleDiscard, isPointInsideDiscard]);

  const handleDiscardDragState = useCallback((active, point) => {
    const over = active ? isPointInsideDiscard(point) : false;
    setDragDiscardState((current) =>
      current.active === active && current.over === over ? current : { active, over },
    );
  }, [isPointInsideDiscard]);

  const handleHandDragState = useCallback((active) => {
    setHandDragging((current) => (current === active ? current : active));
  }, []);

  const handleDrawDeck = useCallback(() => {
    if (!canDraw) return;
    setIsAnimatingAction(true);
    setIncomingSource('deck');
    playSoundEffect('draw');
    drawFromDeckOnline(actionPayload);
    actionAnimationTimeoutRef.current = window.setTimeout(finishOnlineAnimation, 190);
  }, [actionPayload, canDraw, finishOnlineAnimation]);

  const handleDrawDiscard = useCallback(() => {
    if (!canTakeDiscard) return;
    setIsAnimatingAction(true);
    setIncomingSource('discard');
    playSoundEffect('draw');
    drawFromDiscardOnline(actionPayload);
    actionAnimationTimeoutRef.current = window.setTimeout(finishOnlineAnimation, 190);
  }, [actionPayload, canTakeDiscard, finishOnlineAnimation]);

  const handleReorderCard = useCallback((cardId, targetIndex) => {
    applyHandUpdate((currentHand) => {
      const currentIndex = currentHand.findIndex((card) => card.id === cardId);
      if (currentIndex < 0) return currentHand;

      const nextHand = [...currentHand];
      const [movedCard] = nextHand.splice(currentIndex, 1);
      const safeTargetIndex = Math.max(0, Math.min(Number(targetIndex) || 0, nextHand.length));
      nextHand.splice(safeTargetIndex, 0, movedCard);
      reorderHandOnline({
        ...actionPayload,
        handOrder: nextHand.map((card) => card.id),
      });
      return nextHand;
    });
  }, [actionPayload, applyHandUpdate]);

  const handleConfirmLeaveMatch = useCallback(() => {
    surrenderOnlineMatch(actionPayload);
    setMenuMode(null);
    window.setTimeout(() => {
      onLeaveOnline?.();
    }, 220);
  }, [actionPayload, onLeaveOnline]);

  return (
    <main className="game-shell online-game-shell">
      <section className="phone-table wood-frame" aria-label="Pife Duelo Online">
        <button type="button" className="chrome-button menu-button" aria-label="Abrir menu da partida" onClick={() => setMenuMode('menu')}>
          <span />
          <span />
          <span />
        </button>
        <AudioToggle />
        <div
          ref={tableRef}
          className={`felt-table ${handDragging ? 'is-hand-dragging' : ''}`}
        >
          <div className="table-texture" aria-hidden="true" />
          <div className="table-light" aria-hidden="true" />
          <div className="table-vignette" aria-hidden="true" />
          <div className="table-ambience" aria-hidden="true" />
          <div className="felt-logo" aria-hidden="true">
            <span>{"\u2660 \u2665 \u2666 \u2663"}</span>
            <strong>PIFE</strong>
            <small>ONLINE</small>
          </div>

          <GameModal result={showKnockReveal ? null : result} onRestart={onLeaveOnline} />
          <EndGameReveal
            isOpen={showKnockReveal}
            result={onlineGameState.result}
            currentPlayerId={onlineGameState.playerId}
            onNewMatch={onLeaveOnline}
          />
          {economy ? (
            <div className="match-economy-chip" aria-label="Mesa e premio">
              <span>Mesa: {formatMoney(economy.tableValue)}</span>
              <span>Premio: {formatMoney(economy.winnerPrize)}</span>
            </div>
          ) : null}
          <CardFlightLayer flight={onlineFlight} />

          {menuMode ? (
            <div className="match-menu-overlay" role="dialog" aria-modal="true" aria-label="Menu da partida">
              {menuMode === 'menu' ? (
                <aside className="match-menu-panel">
                  <header>
                    <span>Pife Duelo</span>
                    <h2>Menu</h2>
                  </header>
                  <button type="button" onClick={() => setMenuMode(null)}>Continuar Partida</button>
                  <button type="button" onClick={() => setMenuMode('rules')}>Regras do Pife Duelo</button>
                  <button type="button" onClick={() => setMenuMode('history')}>Historico</button>
                  <button type="button" className="danger" onClick={() => setMenuMode('leave')}>Sair da Partida</button>
                </aside>
              ) : null}

              {menuMode === 'rules' ? (
                <section className="match-rules-panel">
                  <header>
                    <button type="button" onClick={() => setMenuMode('menu')}>Voltar</button>
                    <h2>Regras do Pife Duelo</h2>
                  </header>
                  <div className="match-rules-content">
                    <h3>Objetivo</h3>
                    <p>Formar combinacoes validas utilizando todas as cartas da mao e bater antes do adversario.</p>
                    <h3>Combinacoes validas</h3>
                    <strong>1. Trinca</strong>
                    <p>Tres cartas do mesmo valor.</p>
                    <p>Exemplo: 5♠ 5♥ 5♦</p>
                    <strong>2. Sequencia</strong>
                    <p>Tres ou mais cartas do mesmo naipe em sequencia.</p>
                    <p>Exemplo: 7♥ 8♥ 9♥</p>
                    <h3>Regras da rodada</h3>
                    <ul>
                      <li>Comprar uma carta.</li>
                      <li>Organizar a mao.</li>
                      <li>Descartar uma carta.</li>
                      <li>Passar o turno.</li>
                    </ul>
                    <h3>Bater</h3>
                    <p>O jogador pode bater quando sua mao atender as regras validas do Pife.</p>
                    <h3>Tempo</h3>
                    <p>Cada turno possui tempo limite. Se o tempo acabar, ocorre derrota automatica.</p>
                    <h3>Desconexao</h3>
                    <p>Se o jogador permanecer desconectado alem do tempo permitido, ocorre derrota automatica.</p>
                    <h3>Premiacao</h3>
                    <p>O vencedor recebe o premio da mesa apos desconto da taxa da plataforma.</p>
                  </div>
                </section>
              ) : null}

              {menuMode === 'history' ? (
                <section className="current-match-history-panel">
                  <header>
                    <button type="button" onClick={() => setMenuMode('menu')}>Voltar</button>
                    <h2>Historico da partida</h2>
                  </header>
                  <div className="current-match-history-list">
                    {(onlineGameState.matchLog ?? [])
                      .filter((entry) => entry.action !== 'joined_match' && entry.action !== 'playerReorderHand')
                      .map((entry, index) => (
                        <article key={`${entry.timestamp}-${entry.action}-${index}`}>
                          <span>{formatMatchLogEntry(entry, onlineGameState.playerId)}</span>
                          <small>{formatHistoryTime(entry.timestamp)}</small>
                        </article>
                      ))}
                    {(onlineGameState.matchLog ?? []).filter((entry) => entry.action !== 'joined_match' && entry.action !== 'playerReorderHand').length === 0 ? (
                      <p>Nenhuma acao registrada nesta partida ainda.</p>
                    ) : null}
                  </div>
                </section>
              ) : null}

              {menuMode === 'leave' ? (
                <section className="match-leave-panel">
                  <h2>ATENCAO</h2>
                  <p>Sair da partida durante uma partida ativa podera resultar em derrota automatica.</p>
                  <p>Deseja realmente sair?</p>
                  <div>
                    <button type="button" onClick={() => setMenuMode('menu')}>Cancelar</button>
                    <button type="button" className="danger" onClick={handleConfirmLeaveMatch}>Sair da Partida</button>
                  </div>
                </section>
              ) : null}
            </div>
          ) : null}

          <OpponentHand
            count={onlineGameState.opponent?.handCount ?? 0}
            playerName={onlineGameState.opponent?.name ?? 'OPONENTE'}
            isActive={!onlineGameState.isYourTurn && isPlaying}
            isThinking={false}
            statusLabel={opponentTurnStatus}
            statusTone={opponentStatusTone}
          />

          <section className="center-zone" aria-label="Centro da mesa">
            <Timer
              seconds={secondsLeft}
              maxSeconds={turnDurationSeconds}
              variant="table"
              label={turnLabel}
            />
            <DeckArea
              drawCount={onlineGameState.deckCount ?? 0}
              discardCards={displayTopDiscardCard ? [displayTopDiscardCard] : []}
              canDraw={canDraw}
              canTapDraw={canDraw}
              canTakeDiscard={canTakeDiscard}
              onDraw={handleDrawDeck}
              onTakeDiscard={handleDrawDiscard}
              lastAction="online"
              drawRef={drawRef}
              discardRef={discardRef}
              discardDropZoneRef={discardDropZoneRef}
              canDropDiscard={canDiscard}
              isDragTarget={dragDiscardState.active}
              isDragOver={dragDiscardState.over}
              selectedCardId={selectedCardId}
              onDiscardSelected={handleDiscard}
            />
          </section>

          <BeatButton
            canBeat={canBeat}
            onBeat={handleKnock}
            isAnimating={onlineGameState.isResolvingAction}
          />

          {displayedActionError ? <span className="online-action-error">{displayedActionError}</span> : null}

          <section className="bottom-zone" aria-label="Area do jogador">
            <PlayerHand
              cards={hand}
              playerName={onlineGameState.you?.name ?? 'VOCE'}
              statusLabel={playerTurnStatus}
              statusTone={playerStatusTone}
              selectedCardId={selectedCardId}
              onSelectCard={(cardId) => setSelectedCardId((current) => (current === cardId ? null : cardId))}
              isActive={onlineGameState.isYourTurn && isPlaying}
              entryFromDeck={incomingSource === 'deck'}
              entryFromDiscard={incomingSource === 'discard'}
              incomingCardId={incomingCardId}
              canReorder={isPlaying}
              onReorderCard={handleReorderCard}
              canDiscard={canDiscard}
              onDiscardDragEnd={handleDiscardDragEnd}
              onDiscardDragState={handleDiscardDragState}
              onHandDragState={handleHandDragState}
              winningCardIds={[]}
              departingCardId={departingCardId}
            />
          </section>
        </div>
      </section>
    </main>
  );
}
