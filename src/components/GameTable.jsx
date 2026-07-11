import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import ActionHistory from './ActionHistory.jsx';
import AudioToggle from './AudioToggle.jsx';
import BeatButton from './BeatButton.jsx';
import CardFlightLayer from './CardFlightLayer.jsx';
import DeckArea from './DeckArea.jsx';
import EndGameReveal from './EndGameReveal.jsx';
import GameModal from './GameModal.jsx';
import OpponentHand from './OpponentHand.jsx';
import PlayerHand from './PlayerHand.jsx';
import Timer from './Timer.jsx';
import { getDebugScenarioConfig, readDebugScenarioKey } from '../game/debugScenarios.js';
import {
  arrangeHandForActor,
  discardFromHandForActor,
  discardFromPlayerHand,
  drawFromStockForActor,
  drawFromStock,
  getKnockResultForActor,
  getPlayerKnockResult,
  knockForActor,
  playerKnock,
  playerTimeout,
  planBotTurn,
  arrangePlayerHand,
  reorderHandForActor,
  reorderPlayerHand,
  takeFromDiscardForActor,
  takeFromDiscard,
  timeoutForActor,
} from '../game/matchEngine.js';
import { restartMatch, startMatch } from '../game/matchActions.js';
import { createGameStateSnapshot, createTurnState } from '../game/matchStateModel.js';
import { MATCH_EVENTS, logMatchEvent } from '../game/matchTelemetry.js';
import { playSoundEffect } from '../services/soundEffects.js';
import { buildWhatsAppPlayLink } from '../services/whatsAppLink.js';
import { validatePifeHand } from '../shared/pifeRules.js';

const TURN_SECONDS = 60;
const TOAST_DURATION = 1600;
const DISCARD_ANIMATION_MS = 280;
const BEAT_CONFIRM_MS = 300;
const FLIGHT_COMMIT_MS = 220;
const FLIGHT_CLEAR_MS = 320;
const HAND_REORDER_MS = 160;
const OPPONENT_THINKING_FALLBACK_MS = 8200;

function randomDelay(min, max) {
  return Math.round(min + Math.random() * (max - min));
}

function formatCardLabel(card) {
  if (!card) return 'carta';
  return `${card.rank}${card.symbol}`;
}

function readPlayMode() {
  if (typeof window === 'undefined') return 'bot';

  const params = new URLSearchParams(window.location.search);
  const mode = params.get('mode') || params.get('playMode');
  const multiplayer = params.get('multiplayer');
  const local = params.get('local');

  return mode === 'local-2p' || multiplayer === 'local' || local === '2p' ? 'local-2p' : 'bot';
}

function readIsTestMode() {
  if (typeof window === 'undefined') return false;
  const params = new URLSearchParams(window.location.search);
  return params.get('mode') === 'test';
}

function getSeatName(actor) {
  return actor === 'player' ? 'JOGADOR A' : 'JOGADOR B';
}

export default function GameTable() {
  const playMode = useMemo(() => readPlayMode(), []);
  const isTestMode = useMemo(() => readIsTestMode(), []);
  const isLocalMultiplayer = playMode === 'local-2p';
  const debugScenarioKey = useMemo(() => readDebugScenarioKey(), []);
  const debugConfig = useMemo(() => getDebugScenarioConfig(debugScenarioKey), [debugScenarioKey]);
  const turnSeconds = debugConfig?.timerSeconds ?? TURN_SECONDS;
  const initialMatch = useMemo(() => startMatch({ scenarioKey: debugScenarioKey }), [debugScenarioKey]);
  const [game, setGame] = useState(() => initialMatch.game);
  const [matchMeta, setMatchMeta] = useState(() => initialMatch.meta);
  const [selectedCardId, setSelectedCardId] = useState(null);
  const [seconds, setSeconds] = useState(turnSeconds);
  const [botThinking, setBotThinking] = useState(false);
  const [toast, setToast] = useState(null);
  const [lastAction, setLastAction] = useState('deal');
  const [incomingCardId, setIncomingCardId] = useState(null);
  const [beatImpact, setBeatImpact] = useState(false);
  const [isRecycling, setIsRecycling] = useState(false);
  const [turnTransitioning, setTurnTransitioning] = useState(false);
  const [winningCardIds, setWinningCardIds] = useState([]);
  const [departingCardId, setDepartingCardId] = useState(null);
  const [flight, setFlight] = useState(null);
  const [flyingDrawCard, setFlyingDrawCard] = useState(null);
  const [turnCue, setTurnCue] = useState(null);
  const [botPhase, setBotPhase] = useState('idle');
  const [actionHistory, setActionHistory] = useState([]);
  const [dragDiscardState, setDragDiscardState] = useState({ active: false, over: false });
  const [handDragging, setHandDragging] = useState(false);
  const [isResolvingAction, setIsResolvingAction] = useState(false);
  const [testMenuMode, setTestMenuMode] = useState(null);
  const currentTurn = game.currentTurn;
  const activeActor = currentTurn;
  const playerTurn = currentTurn === 'player';
  const isAnimating = turnTransitioning || Boolean(flyingDrawCard);
  const opponentThinking = botThinking;
  const activeHumanTurn = isLocalMultiplayer || playerTurn;
  const hasDrawn = game.turnStage === 'awaiting-discard';
  const result = game.result;
  const canPlayerAct = activeHumanTurn && !isAnimating && !isResolvingAction && !result;
  const activeCards = isLocalMultiplayer && activeActor === 'bot' ? game.opponentHand : game.playerHand;
  const waitingCards = isLocalMultiplayer && activeActor === 'bot' ? game.playerHand : game.opponentHand;
  const activeName = isLocalMultiplayer ? getSeatName(activeActor) : 'VOCE';
  const waitingName = isLocalMultiplayer ? getSeatName(playerTurn ? 'bot' : 'player') : 'OPONENTE';
  const actorHistoryName = isLocalMultiplayer ? activeName : 'Voce';
  const turnBannerLabel = isLocalMultiplayer
    ? `VEZ ${activeName}`
    : playerTurn
      ? 'SUA VEZ'
      : 'VEZ OPONENTE';
  const tableRef = useRef(null);
  const drawRef = useRef(null);
  const discardRef = useRef(null);
  const gameRef = useRef(game);
  const beatImpactTimeoutRef = useRef(null);
  const recycleTimeoutRef = useRef(null);
  const turnTimeoutRef = useRef(null);
  const resultTimeoutRef = useRef(null);
  const flightCommitTimeoutRef = useRef(null);
  const flightClearTimeoutRef = useRef(null);
  const handReorderTimeoutRef = useRef(null);
  const turnCueTimeoutRef = useRef(null);
  const botSequenceTimeoutsRef = useRef([]);
  const opponentThinkingFallbackRef = useRef(null);
  const resolvingActionRef = useRef(false);
  const startedLogRef = useRef(false);
  const previousHumanTurnRef = useRef(Boolean(activeHumanTurn && !result));
  const alertTurnRef = useRef(null);
  const resultSoundRef = useRef(null);
  const resultScreenLogRef = useRef(null);
  const testModeWhatsAppOpeningRef = useRef(false);
  const testModeInteractionLockLogRef = useRef(null);
  const testModeTurnLogRef = useRef(null);

  useEffect(() => {
    gameRef.current = game;
  }, [game]);

  useEffect(() => {
    if (!isTestMode || isLocalMultiplayer || result) return undefined;

    const handleBeforeUnload = (event) => {
      event.preventDefault();
      event.returnValue = '';
      return '';
    };

    window.addEventListener('beforeunload', handleBeforeUnload);
    return () => window.removeEventListener('beforeunload', handleBeforeUnload);
  }, [isLocalMultiplayer, isTestMode, result]);

  const logGameEvent = useCallback((eventName, { game: eventGame = gameRef.current, actor = eventGame?.currentTurn, reason, extra } = {}) => {
    logMatchEvent(eventName, {
      matchId: matchMeta.matchId,
      game: eventGame,
      actor,
      reason,
      extra,
    });
  }, [matchMeta.matchId]);

  useEffect(() => {
    if (startedLogRef.current) return;
    startedLogRef.current = true;
    logGameEvent(MATCH_EVENTS.MATCH_STARTED, {
      game,
      actor: 'player',
      extra: {
        players: ['player', 'bot'],
      },
    });
  }, []);

  const showToast = useCallback((message) => {
    setToast({ id: `${Date.now()}-${Math.random()}`, message });
  }, []);

  const addActionHistory = useCallback((message) => {
    setActionHistory((current) => [
      { id: `${Date.now()}-${Math.random()}`, message },
      ...current,
    ].slice(0, 2));
  }, []);

  const clearBotSequence = useCallback(() => {
    botSequenceTimeoutsRef.current.forEach((timeout) => window.clearTimeout(timeout));
    botSequenceTimeoutsRef.current = [];
  }, []);

  const resetOpponentState = useCallback(() => {
    if (opponentThinkingFallbackRef.current) {
      window.clearTimeout(opponentThinkingFallbackRef.current);
      opponentThinkingFallbackRef.current = null;
    }
    setBotThinking(false);
    setBotPhase('idle');
    setTurnTransitioning(false);
  }, []);

  const scheduleBotStep = useCallback((delay, callback) => {
    const timeout = window.setTimeout(() => {
      botSequenceTimeoutsRef.current = botSequenceTimeoutsRef.current.filter((item) => item !== timeout);
      callback();
    }, delay);

    botSequenceTimeoutsRef.current.push(timeout);
    return timeout;
  }, []);

  useEffect(() => {
    if (!toast) return undefined;
    const timeout = window.setTimeout(() => setToast(null), TOAST_DURATION);
    return () => window.clearTimeout(timeout);
  }, [toast]);

  useEffect(() => {
    const isHumanTurn = Boolean(activeHumanTurn && !result);
    if (isHumanTurn && !previousHumanTurnRef.current) {
      playSoundEffect('turn');
    }
    previousHumanTurnRef.current = isHumanTurn;
  }, [activeHumanTurn, currentTurn, matchMeta.turnsPlayed, result]);

  useEffect(() => {
    if (!activeHumanTurn || result || seconds > 10 || seconds <= 0) return;

    const alertKey = `${matchMeta.matchId}-${matchMeta.turnsPlayed}-${currentTurn}`;
    if (alertTurnRef.current === alertKey) return;

    alertTurnRef.current = alertKey;
    playSoundEffect('alert');
  }, [activeHumanTurn, currentTurn, matchMeta.matchId, matchMeta.turnsPlayed, result, seconds]);

  useEffect(() => {
    if (!result) return;

    const resultKey = `${matchMeta.matchId}-${result.winner}-${result.type}`;
    if (resultSoundRef.current === resultKey) return;

    resultSoundRef.current = resultKey;
    playSoundEffect(result.winner === 'player' || result.type === 'win' ? 'win' : 'loss');
  }, [matchMeta.matchId, result]);

  useEffect(
    () => () => {
      if (beatImpactTimeoutRef.current) {
        window.clearTimeout(beatImpactTimeoutRef.current);
      }
      if (recycleTimeoutRef.current) {
        window.clearTimeout(recycleTimeoutRef.current);
      }
      if (turnTimeoutRef.current) {
        window.clearTimeout(turnTimeoutRef.current);
      }
      if (resultTimeoutRef.current) {
        window.clearTimeout(resultTimeoutRef.current);
      }
      if (flightCommitTimeoutRef.current) {
        window.clearTimeout(flightCommitTimeoutRef.current);
      }
      if (flightClearTimeoutRef.current) {
        window.clearTimeout(flightClearTimeoutRef.current);
      }
      if (handReorderTimeoutRef.current) {
        window.clearTimeout(handReorderTimeoutRef.current);
      }
      if (turnCueTimeoutRef.current) {
        window.clearTimeout(turnCueTimeoutRef.current);
      }
      if (opponentThinkingFallbackRef.current) {
        window.clearTimeout(opponentThinkingFallbackRef.current);
      }
      clearBotSequence();
    },
    [clearBotSequence],
  );

  const getLocalBox = useCallback((element, fallback) => {
    const tableRect = tableRef.current?.getBoundingClientRect();
    const rect = element?.getBoundingClientRect?.();
    const source = rect && tableRect ? rect : fallback;

    if (!source || !tableRect) {
      return {
        x: 0,
        y: 0,
        width: 46,
        height: 66,
      };
    }

    return {
      x: source.left - tableRect.left + source.width / 2,
      y: source.top - tableRect.top + source.height / 2,
      width: source.width,
      height: source.height,
    };
  }, []);

  const getHandTargetBox = useCallback(() => {
    const handElement = tableRef.current?.querySelector('.card-fan-player');
    const handRect = handElement?.getBoundingClientRect?.();
    const tableRect = tableRef.current?.getBoundingClientRect();
    const cardElement = tableRef.current?.querySelector('.card-fan-player .playing-card');
    const cardRect = cardElement?.getBoundingClientRect?.();

    if (!handRect || !tableRect) {
      return { x: 0, y: 0, width: 72, height: 104 };
    }

    return {
      x: handRect.right - tableRect.left - (cardRect?.width ?? 72) * 0.42,
      y: handRect.top - tableRect.top + handRect.height * 0.58,
      width: cardRect?.width ?? 72,
      height: cardRect?.height ?? 104,
    };
  }, []);

  const getOpponentTargetBox = useCallback(() => {
    const handElement = tableRef.current?.querySelector('.card-fan-opponent');
    const handRect = handElement?.getBoundingClientRect?.();
    const tableRect = tableRef.current?.getBoundingClientRect();
    const cardElement = tableRef.current?.querySelector('.card-fan-opponent .card-back');
    const cardRect = cardElement?.getBoundingClientRect?.();

    if (!handRect || !tableRect) {
      return { x: 0, y: 0, width: 46, height: 66 };
    }

    return {
      x: handRect.left - tableRect.left + handRect.width / 2,
      y: handRect.top - tableRect.top + handRect.height * 0.45,
      width: cardRect?.width ?? 46,
      height: cardRect?.height ?? 66,
    };
  }, []);

  const makeFlight = useCallback(({ kind, card, faceDown = false, from, to, fromRotate = 0, toRotate = 0 }) => {
    const lift = kind === 'discard' ? 6 : 54;

    return {
      id: `${kind}-${card.id}-${Date.now()}`,
      kind,
      card,
      faceDown,
      from,
      to,
      mid: {
        x: (from.x + to.x) / 2,
        y: Math.min(from.y, to.y) - lift,
      },
      fromRotate,
      midRotate: kind === 'discard' ? 0 : 5,
      toRotate: kind === 'discard' ? Math.max(-0.8, Math.min(0.8, toRotate)) : toRotate,
      fromScale: 1,
      midScale: kind === 'discard' ? 1 : 1.08,
      toScale: kind === 'discard' ? 1 : Math.max(0.54, Math.min(1.22, to.width / Math.max(from.width, 1))),
      finalScale: Math.max(0.54, Math.min(1.22, to.width / Math.max(from.width, 1))),
      duration: kind === 'discard' ? 0.28 : 0.3,
    };
  }, []);

  const scheduleFlight = useCallback((nextFlight, commit, options = {}) => {
    if (flightCommitTimeoutRef.current) {
      window.clearTimeout(flightCommitTimeoutRef.current);
    }
    if (flightClearTimeoutRef.current) {
      window.clearTimeout(flightClearTimeoutRef.current);
    }

    setFlight(nextFlight);

    if (options.commitAfterClear) {
      // Fluxo visual da compra: a mão atual fica estável até a carta em voo terminar.
      flightClearTimeoutRef.current = window.setTimeout(() => {
        setFlight(null);
        setFlyingDrawCard(null);
        setDepartingCardId(null);
        flightClearTimeoutRef.current = null;
        commit();
      }, options.clearDelay ?? FLIGHT_CLEAR_MS);
      return;
    }

    flightCommitTimeoutRef.current = window.setTimeout(() => {
      flightCommitTimeoutRef.current = null;
      commit();
    }, options.commitDelay ?? FLIGHT_COMMIT_MS);
    flightClearTimeoutRef.current = window.setTimeout(() => {
      setFlight(null);
      setFlyingDrawCard(null);
      setDepartingCardId(null);
      flightClearTimeoutRef.current = null;
    }, options.clearDelay ?? FLIGHT_CLEAR_MS);
  }, []);

  const settleHandAfterDraw = useCallback((actor, nextGame, drawnCardId, sourceLabel) => {
    const arrangeAction = isLocalMultiplayer
      ? arrangeHandForActor(nextGame, actor, { handMode: 'manual' })
      : arrangePlayerHand(nextGame, { handMode: 'manual' });
    setGame(arrangeAction.blocked ? nextGame : arrangeAction.game);
    setIncomingCardId(drawnCardId);
    if (handReorderTimeoutRef.current) {
      window.clearTimeout(handReorderTimeoutRef.current);
    }

    handReorderTimeoutRef.current = window.setTimeout(() => {
      setIncomingCardId(null);
      setSelectedCardId(null);
      setDragDiscardState({ active: false, over: false });
      setHandDragging(false);
      setIsResolvingAction(false);
      resolvingActionRef.current = false;
      setTurnTransitioning(false);
      showToast(sourceLabel);
    }, HAND_REORDER_MS);
  }, [isLocalMultiplayer, showToast]);

  const pulseTurnCue = useCallback((target) => {
    if (turnCueTimeoutRef.current) {
      window.clearTimeout(turnCueTimeoutRef.current);
    }

    setTurnCue({ id: `${target}-${Date.now()}`, target });
    turnCueTimeoutRef.current = window.setTimeout(() => setTurnCue(null), 760);
  }, []);

  useEffect(() => {
    if (result) return;
    pulseTurnCue(isLocalMultiplayer || playerTurn ? 'player' : 'opponent');
  }, [isLocalMultiplayer, playerTurn, pulseTurnCue, result]);

  useEffect(() => {
    if (!playerTurn || isLocalMultiplayer) return;
    resetOpponentState();
    setSelectedCardId(null);
    setIncomingCardId(null);
    setDepartingCardId(null);
    setDragDiscardState({ active: false, over: false });
    setHandDragging(false);
    setIsResolvingAction(false);
    resolvingActionRef.current = false;
    setSeconds(turnSeconds);
    if (isTestMode) {
      console.info('TEST_MODE_HAND_UNLOCKED', {
        playerTurn: true,
        handSize: gameRef.current.playerHand.length,
        canBeat: validatePifeHand(gameRef.current.playerHand).canBeat,
        interactionLocked: false,
        actionPending: false,
        discardPending: false,
      });
    }
  }, [isLocalMultiplayer, isTestMode, playerTurn, resetOpponentState, turnSeconds]);

  const showBeatImpact = useCallback(() => {
    if (beatImpactTimeoutRef.current) {
      window.clearTimeout(beatImpactTimeoutRef.current);
    }
    setBeatImpact(true);
    beatImpactTimeoutRef.current = window.setTimeout(() => setBeatImpact(false), 390);
  }, []);

  const showRecycleEffect = useCallback(() => {
    if (recycleTimeoutRef.current) {
      window.clearTimeout(recycleTimeoutRef.current);
    }
    setIsRecycling(true);
    recycleTimeoutRef.current = window.setTimeout(() => setIsRecycling(false), 850);
  }, []);

  const restart = useCallback(() => {
    clearBotSequence();
    const oldMatchId = matchMeta.matchId;
    const nextMatch = restartMatch({ scenarioKey: debugScenarioKey });
    startedLogRef.current = true;
    resultScreenLogRef.current = null;
    setGame(nextMatch.game);
    setMatchMeta(nextMatch.meta);
    setSelectedCardId(null);
    setSeconds(turnSeconds);
    setBotThinking(false);
    setLastAction('deal');
    setIncomingCardId(null);
    setBeatImpact(false);
    setIsRecycling(false);
    setTurnTransitioning(false);
    setWinningCardIds([]);
    setDepartingCardId(null);
    setFlight(null);
    setFlyingDrawCard(null);
    setTurnCue(null);
    setBotPhase('idle');
    setActionHistory([]);
    setDragDiscardState({ active: false, over: false });
    setHandDragging(false);
    setIsResolvingAction(false);
    resolvingActionRef.current = false;
    logMatchEvent(MATCH_EVENTS.MATCH_RESTARTED, {
      matchId: nextMatch.meta.matchId,
      game: nextMatch.game,
      actor: 'player',
    });
    logMatchEvent(MATCH_EVENTS.MATCH_STARTED, {
      matchId: nextMatch.meta.matchId,
      game: nextMatch.game,
      actor: 'player',
      extra: {
        players: ['player', 'bot'],
      },
    });
    if (isTestMode) {
      console.info('TEST_MODE_RESTART', {
        oldMatchId,
        newMatchId: nextMatch.meta.matchId,
      });
    }
    showToast(debugScenarioKey ? `Cenario ${debugScenarioKey} reiniciado` : 'Nova rodada iniciada');
  }, [clearBotSequence, debugScenarioKey, isTestMode, matchMeta.matchId, showToast, turnSeconds]);

  const clearTestModeRuntimeState = useCallback(() => {
    clearBotSequence();
    [
      beatImpactTimeoutRef,
      recycleTimeoutRef,
      turnTimeoutRef,
      resultTimeoutRef,
      flightCommitTimeoutRef,
      flightClearTimeoutRef,
      handReorderTimeoutRef,
      turnCueTimeoutRef,
      opponentThinkingFallbackRef,
    ].forEach((ref) => {
      if (ref.current) {
        window.clearTimeout(ref.current);
        ref.current = null;
      }
    });
    window.__PIFE_DUELO_PHASE3_STATE__ = null;
    resolvingActionRef.current = false;
  }, [clearBotSequence]);

  const exitTestMode = useCallback(({ target = 'menu' } = {}) => {
    if (!isTestMode) return;
    const currentMatchId = matchMeta.matchId;
    clearTestModeRuntimeState();
    if (target === 'paid') {
      console.info('TEST_MODE_GO_TO_PAID_FLOW', {
        from: 'test_mode_result',
      });
    } else {
      console.info('TEST_MODE_EXIT_TO_MENU', {
        matchId: currentMatchId,
        cleared: true,
      });
    }
    window.location.href = '/?online=1';
  }, [clearTestModeRuntimeState, isTestMode, matchMeta.matchId]);

  const goToPaidFlowFromTestMode = useCallback(() => {
    exitTestMode({ target: 'paid' });
  }, [exitTestMode]);

  const openWhatsAppFromTestMode = useCallback(() => {
    if (testModeWhatsAppOpeningRef.current) return;
    testModeWhatsAppOpeningRef.current = true;
    console.info('TEST_MODE_GO_TO_WHATSAPP', {
      from: 'test_mode_result',
      matchId: matchMeta.matchId,
    });
    window.location.href = buildWhatsAppPlayLink();
    window.setTimeout(() => {
      testModeWhatsAppOpeningRef.current = false;
    }, 1800);
  }, [matchMeta.matchId]);

  const copyWhatsAppLinkFromTestMode = useCallback(async () => {
    const link = buildWhatsAppPlayLink();
    try {
      await navigator.clipboard?.writeText?.(link);
      showToast('Link do WhatsApp copiado.');
    } catch {
      showToast('Nao abriu? Copie o link e abra no navegador.');
    }
  }, [showToast]);

  const openTestModeMenu = useCallback(() => {
    if (!isTestMode) return;
    console.info('TEST_MODE_MENU_OPEN', {
      mode: 'test',
      matchId: matchMeta.matchId,
    });
    setTestMenuMode('menu');
  }, [isTestMode, matchMeta.matchId]);

  const closeTestModeMenu = useCallback(({ action = 'continue' } = {}) => {
    if (!isTestMode) return;
    console.info('TEST_MODE_MENU_ACTION', {
      action,
      mode: 'test',
      matchId: matchMeta.matchId,
    });
    console.info('TEST_MODE_MENU_CLOSE', {
      mode: 'test',
      matchId: matchMeta.matchId,
    });
    setTestMenuMode(null);
  }, [isTestMode, matchMeta.matchId]);

  const showTestModeRules = useCallback(() => {
    if (!isTestMode) return;
    console.info('TEST_MODE_MENU_ACTION', {
      action: 'rules',
      mode: 'test',
      matchId: matchMeta.matchId,
    });
    setTestMenuMode('rules');
  }, [isTestMode, matchMeta.matchId]);

  const restartTestFromMenu = useCallback(() => {
    if (!isTestMode) return;
    console.info('TEST_MODE_MENU_ACTION', {
      action: 'restart_test',
      mode: 'test',
      matchId: matchMeta.matchId,
    });
    console.info('TEST_MODE_MENU_CLOSE', {
      mode: 'test',
      matchId: matchMeta.matchId,
    });
    setTestMenuMode(null);
    restart();
  }, [isTestMode, matchMeta.matchId, restart]);

  const goToPaidFlowFromTestMenu = useCallback(() => {
    if (!isTestMode) return;
    console.info('TEST_MODE_MENU_ACTION', {
      action: 'go_paid',
      mode: 'test',
      matchId: matchMeta.matchId,
    });
    console.info('TEST_MODE_MENU_CLOSE', {
      mode: 'test',
      matchId: matchMeta.matchId,
    });
    goToPaidFlowFromTestMode();
  }, [goToPaidFlowFromTestMode, isTestMode, matchMeta.matchId]);

  const exitTestFromMenu = useCallback(() => {
    if (!isTestMode) return;
    console.info('TEST_MODE_MENU_ACTION', {
      action: 'exit_test',
      mode: 'test',
      matchId: matchMeta.matchId,
    });
    console.info('TEST_MODE_MENU_CLOSE', {
      mode: 'test',
      matchId: matchMeta.matchId,
    });
    exitTestMode({ target: 'menu' });
  }, [exitTestMode, isTestMode, matchMeta.matchId]);

  useEffect(() => {
    if (!isTestMode || !result) return;
    const logKey = `${matchMeta.matchId}:${result.winner}:${result.type}`;
    if (resultScreenLogRef.current === logKey) return;
    resultScreenLogRef.current = logKey;
    console.info('TEST_MODE_RESULT_SCREEN', {
      result: result.type,
      winner: result.winner,
      player: 'player',
      matchId: matchMeta.matchId,
    });
  }, [isTestMode, matchMeta.matchId, result]);

  const drawCardForPlayer = useCallback(() => {
    if (!activeHumanTurn || turnTransitioning || result) {
      logGameEvent(MATCH_EVENTS.INVALID_ACTION_BLOCKED, { actor: activeActor, reason: 'draw-not-allowed' });
      return;
    }
    if (hasDrawn || activeCards.length >= 10) {
      logGameEvent(MATCH_EVENTS.INVALID_ACTION_BLOCKED, { actor: activeActor, reason: 'draw-stage-blocked' });
      showToast('Voce ja comprou. Selecione uma carta e toque no descarte.');
      return;
    }

    const drawAction = isLocalMultiplayer
      ? drawFromStockForActor(game, activeActor, { handMode: 'manual' })
      : drawFromStock(game, { handMode: 'manual' });

    if (drawAction.recycled) {
      showRecycleEffect();
    }

    if (drawAction.blocked) {
      logGameEvent(MATCH_EVENTS.INVALID_ACTION_BLOCKED, { actor: activeActor, reason: drawAction.reason });
      showToast('Sem cartas para reciclar ainda.');
      return;
    }

    const from = getLocalBox(drawRef.current);
    const to = getHandTargetBox();
    const nextFlight = makeFlight({
      kind: 'draw',
      card: drawAction.drawnCard,
      faceDown: true,
      from,
      to,
      fromRotate: -7,
      toRotate: 2,
    });

    setTurnTransitioning(true);
    setFlyingDrawCard(drawAction.drawnCard);
    playSoundEffect('draw');
    scheduleFlight(
      nextFlight,
      () => {
        setLastAction('player-draw');
        logGameEvent(MATCH_EVENTS.CARD_DRAWN, {
          game: drawAction.game,
          actor: activeActor,
          extra: { source: 'stock', cardId: drawAction.drawnCard.id },
        });
        addActionHistory(`${actorHistoryName} comprou do monte`);
        settleHandAfterDraw(activeActor, drawAction.game, drawAction.drawnCard.id, 'Carta comprada. Toque uma carta e depois o descarte.');
      },
      { commitAfterClear: true },
    );
  }, [activeActor, activeCards.length, activeHumanTurn, actorHistoryName, addActionHistory, game, getHandTargetBox, getLocalBox, hasDrawn, isLocalMultiplayer, logGameEvent, makeFlight, result, scheduleFlight, settleHandAfterDraw, showRecycleEffect, showToast, turnTransitioning]);

  const takeDiscardForPlayer = useCallback(() => {
    const topDiscard = game.discardPile[game.discardPile.length - 1];

    if (!activeHumanTurn || turnTransitioning || result || !topDiscard) {
      logGameEvent(MATCH_EVENTS.INVALID_ACTION_BLOCKED, { actor: activeActor, reason: 'take-discard-not-allowed' });
      return;
    }
    if (hasDrawn || activeCards.length >= 10) {
      logGameEvent(MATCH_EVENTS.INVALID_ACTION_BLOCKED, { actor: activeActor, reason: 'take-discard-stage-blocked' });
      showToast('Voce ja pegou uma carta. Selecione uma carta e toque no descarte.');
      return;
    }
    if (topDiscard.discardedBy === activeActor) {
      logGameEvent(MATCH_EVENTS.INVALID_ACTION_BLOCKED, { actor: activeActor, reason: 'own-discard' });
      showToast('Pegue apenas a carta descartada pelo adversario.');
      return;
    }

    const takeAction = isLocalMultiplayer
      ? takeFromDiscardForActor(game, activeActor, { handMode: 'manual' })
      : takeFromDiscard(game, { handMode: 'manual' });

    if (takeAction.blocked) {
      logGameEvent(MATCH_EVENTS.INVALID_ACTION_BLOCKED, { actor: activeActor, reason: takeAction.reason });
      return;
    }

    const from = getLocalBox(discardRef.current);
    const to = getHandTargetBox();
    const nextFlight = makeFlight({
      kind: 'draw-discard',
      card: takeAction.takenCard,
      faceDown: false,
      from,
      to,
      fromRotate: 3,
      toRotate: -2,
    });

    setTurnTransitioning(true);
    setFlyingDrawCard(takeAction.takenCard);
    playSoundEffect('draw');
    scheduleFlight(
      nextFlight,
      () => {
        setLastAction('player-take-discard');
        logGameEvent(MATCH_EVENTS.CARD_DRAWN, {
          game: takeAction.game,
          actor: activeActor,
          extra: { source: 'discard', cardId: takeAction.takenCard.id },
        });
        addActionHistory(`${actorHistoryName} comprou ${formatCardLabel(takeAction.takenCard)} do descarte`);
        settleHandAfterDraw(activeActor, takeAction.game, takeAction.takenCard.id, 'Carta do descarte aproveitada. Agora toque no descarte.');
      },
      { commitAfterClear: true },
    );
  }, [activeActor, activeCards.length, activeHumanTurn, actorHistoryName, addActionHistory, game, getHandTargetBox, getLocalBox, hasDrawn, isLocalMultiplayer, logGameEvent, makeFlight, result, scheduleFlight, settleHandAfterDraw, showToast, turnTransitioning]);

  const discardCardById = useCallback((cardId, originPoint = null) => {
    if (!activeHumanTurn || turnTransitioning || !cardId || result) {
      logGameEvent(MATCH_EVENTS.INVALID_ACTION_BLOCKED, { actor: activeActor, reason: 'discard-not-allowed' });
      return;
    }
    if (activeCards.length !== 10) {
      logGameEvent(MATCH_EVENTS.INVALID_ACTION_BLOCKED, { actor: activeActor, reason: 'discard-without-draw' });
      showToast('Toque no baralho de compra antes de descartar.');
      return;
    }

    const discardAction = isLocalMultiplayer
      ? discardFromHandForActor(game, activeActor, cardId, { handMode: 'manual' })
      : discardFromPlayerHand(game, cardId, { handMode: 'manual' });
    if (discardAction.blocked) {
      logGameEvent(MATCH_EVENTS.INVALID_ACTION_BLOCKED, { actor: activeActor, reason: discardAction.reason });
      return;
    }

    const canBeatBeforeDiscard = isTestMode && !isLocalMultiplayer
      ? validatePifeHand(activeCards).canBeat
      : false;
    if (isTestMode && !isLocalMultiplayer) {
      console.info('TEST_MODE_DISCARD_STARTED', {
        playerTurn: Boolean(activeHumanTurn),
        handSize: activeCards.length,
        canBeat: canBeatBeforeDiscard,
        interactionLocked: true,
        actionPending: true,
        discardPending: true,
      });
    }

    const cardElement = tableRef.current?.querySelector(`[data-card-id="${CSS.escape(cardId)}"]`);
    const cardRect = cardElement?.getBoundingClientRect?.();
    const tableRect = tableRef.current?.getBoundingClientRect?.();
    const from = originPoint && tableRect
      ? {
          x: originPoint.x - tableRect.left,
          y: originPoint.y - tableRect.top,
          width: cardRect?.width ?? 72,
          height: cardRect?.height ?? 104,
        }
      : getLocalBox(cardElement);
    const to = getLocalBox(discardRef.current);
    const nextFlight = makeFlight({
      kind: 'discard',
      card: discardAction.discardedCard,
      faceDown: false,
      from,
      to,
      fromRotate: 0,
      toRotate: 0,
    });

    setDepartingCardId(cardId);
    setSelectedCardId(null);
    setDragDiscardState({ active: false, over: false });
    setHandDragging(false);
    setIsResolvingAction(false);
    resolvingActionRef.current = false;
    setTurnTransitioning(true);
    playSoundEffect('discard');
    scheduleFlight(
      nextFlight,
      () => {
        setGame(discardAction.game);
        setLastAction('player-discard');
        setIncomingCardId(null);
        setDepartingCardId(null);
        setSelectedCardId(null);
        setDragDiscardState({ active: false, over: false });
        setHandDragging(false);
        setIsResolvingAction(false);
        resolvingActionRef.current = false;
        setSeconds(turnSeconds);
        setTurnTransitioning(false);
        setMatchMeta((current) => ({
          ...current,
          turnsPlayed: current.turnsPlayed + 1,
        }));
        logGameEvent(MATCH_EVENTS.CARD_DISCARDED, {
          game: discardAction.game,
          actor: activeActor,
          extra: { cardId: discardAction.discardedCard.id },
        });
        logGameEvent(MATCH_EVENTS.TURN_CHANGED, {
          game: discardAction.game,
          actor: discardAction.game.currentTurn,
        });
        if (isTestMode && !isLocalMultiplayer) {
          console.info('TEST_MODE_DISCARD_COMPLETED', {
            playerTurn: discardAction.game.currentTurn === 'player',
            handSize: discardAction.game.playerHand.length,
            canBeat: validatePifeHand(discardAction.game.playerHand).canBeat,
            interactionLocked: discardAction.game.currentTurn !== 'player',
            actionPending: false,
            discardPending: false,
          });
        }
        addActionHistory(`${actorHistoryName} descartou ${formatCardLabel(discardAction.discardedCard)}`);
        showToast(isLocalMultiplayer ? `Passe para ${getSeatName(discardAction.game.currentTurn)}.` : 'Carta descartada.');
      },
      { commitDelay: DISCARD_ANIMATION_MS, clearDelay: FLIGHT_CLEAR_MS },
    );
  }, [activeActor, activeCards, activeHumanTurn, actorHistoryName, addActionHistory, game, getLocalBox, isLocalMultiplayer, isTestMode, logGameEvent, makeFlight, result, scheduleFlight, showToast, turnSeconds, turnTransitioning]);

  const cancelCardSelection = useCallback((event) => {
    if (!selectedCardId || turnTransitioning) return;

    const target = event.target;
    if (
      target.closest?.(
        '[data-card-control="true"], .deck-area, .action-bar, .beat-button, .game-modal-backdrop, .chrome-button',
      )
    ) {
      return;
    }

    setSelectedCardId(null);
  }, [selectedCardId, turnTransitioning]);

  const isPointInsideDiscard = useCallback((point) => {
    const discardBounds = discardRef.current?.getBoundingClientRect();
    if (!discardBounds || !point) return false;

    return (
      point.x >= discardBounds.left &&
      point.x <= discardBounds.right &&
      point.y >= discardBounds.top &&
      point.y <= discardBounds.bottom
    );
  }, []);

  const handleCardDiscardDragState = useCallback((active, point) => {
    if (!active) {
      setDragDiscardState({ active: false, over: false });
      return;
    }

    const over = isPointInsideDiscard(point);
    setDragDiscardState((current) =>
      current.active === active && current.over === over ? current : { active, over },
    );
  }, [isPointInsideDiscard]);

  const handleHandDragState = useCallback((active) => {
    setHandDragging((current) => (current === active ? current : active));
  }, []);

  const handleCardDiscardDragEnd = useCallback((cardId, point) => {
    const overDiscard = isPointInsideDiscard(point);
    setDragDiscardState({ active: false, over: false });

    if (!overDiscard) {
      showToast('Solte a carta no descarte.');
      return;
    }

    discardCardById(cardId, point);
  }, [discardCardById, isPointInsideDiscard, showToast]);

  const reorderCardByDrop = useCallback((cardId, targetIndex) => {
    setSelectedCardId(null);
    setIncomingCardId(null);
    setGame((current) => {
      const reorderAction = isLocalMultiplayer
        ? reorderHandForActor(current, current.currentTurn, cardId, targetIndex)
        : reorderPlayerHand(current, cardId, targetIndex);
      return reorderAction.blocked ? current : reorderAction.game;
    });
  }, [isLocalMultiplayer]);

  const activeCardSignature = activeCards.map((card) => card.id).join('|');
  const testModeBatEvaluation = useMemo(
    () => validatePifeHand(activeCards),
    [activeCardSignature],
  );
  const knockValidation = useMemo(
    () => {
      if (isTestMode && !isLocalMultiplayer) {
        return {
          valid: testModeBatEvaluation.canBeat,
          groups: testModeBatEvaluation.validGroups.map((group) => group.cards),
          validGroups: testModeBatEvaluation.validGroups,
          remainingCards: testModeBatEvaluation.remainingCards,
          deadwood: testModeBatEvaluation.remainingCards,
          usedExtraCards: [],
        };
      }
      return isLocalMultiplayer ? getKnockResultForActor(game, activeActor) : getPlayerKnockResult(game);
    },
    [activeActor, game, isLocalMultiplayer, isTestMode, testModeBatEvaluation],
  );

  const knock = useCallback(() => {
    const canTryKnock = isTestMode && !isLocalMultiplayer
      ? activeHumanTurn && !handDragging && !isResolvingAction && !resolvingActionRef.current && !result
      : activeHumanTurn && !turnTransitioning && !handDragging && !isResolvingAction && !resolvingActionRef.current && !result;
    if (!canTryKnock) return;

    const currentKnockValidation = isTestMode && !isLocalMultiplayer
      ? knockValidation
      : isLocalMultiplayer ? getKnockResultForActor(game, activeActor) : getPlayerKnockResult(game);
    if (!currentKnockValidation.valid) {
      logGameEvent(MATCH_EVENTS.INVALID_ACTION_BLOCKED, { actor: activeActor, reason: 'invalid-knock' });
      showToast('Ainda falta jogo: forme 3 combinacoes ou use o descarte do bot.');
      return;
    }

    if (handReorderTimeoutRef.current) {
      window.clearTimeout(handReorderTimeoutRef.current);
      handReorderTimeoutRef.current = null;
    }
    resolvingActionRef.current = true;
    setIsResolvingAction(true);
    const knockAction = isLocalMultiplayer ? knockForActor(game, activeActor) : playerKnock(game);
    if (!knockAction.blocked) {
      const { validation } = knockAction;
      playSoundEffect('beat');
      const playerCardIds = new Set(activeCards.map((card) => card.id));
      const confirmedCardIds = validation.groups
        .flatMap((group) => group.cards)
        .filter((card) => playerCardIds.has(card.id))
        .map((card) => card.id);

      setWinningCardIds(confirmedCardIds);
      setTurnTransitioning(true);
      showBeatImpact();
      addActionHistory(`${actorHistoryName} bateu`);
      showToast(isLocalMultiplayer ? `${actorHistoryName} bateu!` : 'Boa! Voce bateu.');
      if (resultTimeoutRef.current) {
        window.clearTimeout(resultTimeoutRef.current);
      }
      resultTimeoutRef.current = window.setTimeout(() => {
        setGame(knockAction.game);
        setMatchMeta((current) => ({
          ...current,
          finishedAt: Date.now(),
        }));
        setTurnTransitioning(false);
        resolvingActionRef.current = false;
        setIsResolvingAction(false);
        logGameEvent(MATCH_EVENTS.PLAYER_KNOCKED, {
          game: knockAction.game,
          actor: activeActor,
        });
        logGameEvent(MATCH_EVENTS.MATCH_FINISHED, {
          game: knockAction.game,
          actor: activeActor,
          reason: 'knock',
        });
      }, BEAT_CONFIRM_MS);
      return;
    }

    resolvingActionRef.current = false;
    setIsResolvingAction(false);
    logGameEvent(MATCH_EVENTS.INVALID_ACTION_BLOCKED, { actor: activeActor, reason: knockAction.reason });
    showToast('Ainda falta jogo: forme 3 combinacoes ou use o descarte do bot.');
  }, [activeActor, activeCards, activeHumanTurn, actorHistoryName, addActionHistory, game, handDragging, isLocalMultiplayer, isResolvingAction, isTestMode, knockValidation, logGameEvent, result, showBeatImpact, showToast, turnTransitioning]);

  useEffect(() => {
    if (!activeHumanTurn || result) return undefined;

    const interval = window.setInterval(() => {
      setSeconds((current) => {
        if (current <= 1) {
          window.clearInterval(interval);
          const activeGame = gameRef.current;
          const timeoutAction = isLocalMultiplayer
            ? timeoutForActor(activeGame, activeGame.currentTurn)
            : playerTimeout(activeGame);
          if (!timeoutAction.blocked) {
            setGame(timeoutAction.game);
            setMatchMeta((current) => ({
              ...current,
              finishedAt: Date.now(),
            }));
            logMatchEvent(MATCH_EVENTS.PLAYER_TIMEOUT, {
              matchId: matchMeta.matchId,
              game: timeoutAction.game,
              actor: activeGame.currentTurn,
              reason: 'timeout',
            });
            logMatchEvent(MATCH_EVENTS.MATCH_FINISHED, {
              matchId: matchMeta.matchId,
              game: timeoutAction.game,
              actor: activeGame.currentTurn,
              reason: 'timeout',
            });
          }
          return 0;
        }
        return current - 1;
      });
    }, 1000);

    return () => window.clearInterval(interval);
  }, [activeHumanTurn, isLocalMultiplayer, matchMeta.matchId, result]);

  useEffect(() => {
    if (isLocalMultiplayer || playerTurn || result) return undefined;

    clearBotSequence();
    setTurnTransitioning(true);
    setBotThinking(true);
    setBotPhase('thinking');
    if (opponentThinkingFallbackRef.current) {
      window.clearTimeout(opponentThinkingFallbackRef.current);
    }
    opponentThinkingFallbackRef.current = window.setTimeout(() => {
      const activeGame = gameRef.current;
      if (botSequenceTimeoutsRef.current.length > 0) {
        return;
      }

      if (activeGame.result || activeGame.currentTurn === 'player') {
        resetOpponentState();
        setSeconds(turnSeconds);
        return;
      }

      clearBotSequence();
      if (flightCommitTimeoutRef.current) {
        window.clearTimeout(flightCommitTimeoutRef.current);
      }
      if (flightClearTimeoutRef.current) {
        window.clearTimeout(flightClearTimeoutRef.current);
      }
      const fallbackAction = planBotTurn(activeGame);
      if (!fallbackAction.blocked && fallbackAction.game) {
        setGame(fallbackAction.game);
        setLastAction(fallbackAction.action === 'bot-knock' ? 'bot-knock' : 'bot-discard');
        if (fallbackAction.action === 'bot-knock') {
          setMatchMeta((current) => ({
            ...current,
            finishedAt: Date.now(),
          }));
          logGameEvent(MATCH_EVENTS.PLAYER_KNOCKED, {
            game: fallbackAction.game,
            actor: 'bot',
            reason: 'bot_win',
          });
          logGameEvent(MATCH_EVENTS.MATCH_FINISHED, {
            game: fallbackAction.game,
            actor: 'bot',
            reason: 'bot_win',
          });
        } else {
          setMatchMeta((current) => ({
            ...current,
            turnsPlayed: current.turnsPlayed + 1,
          }));
          logGameEvent(MATCH_EVENTS.CARD_DISCARDED, {
            game: fallbackAction.game,
            actor: 'bot',
            extra: { cardId: fallbackAction.discardedCard?.id },
          });
          logGameEvent(MATCH_EVENTS.TURN_CHANGED, {
            game: fallbackAction.game,
            actor: fallbackAction.game.currentTurn,
          });
        }
        addActionHistory('Oponente concluiu a jogada');
      } else if (fallbackAction.blocked) {
        logGameEvent(MATCH_EVENTS.INVALID_ACTION_BLOCKED, {
          game: activeGame,
          actor: 'bot',
          reason: fallbackAction.reason,
        });
      }
      setFlight(null);
      setIncomingCardId(null);
      setDepartingCardId(null);
      resetOpponentState();
      setSeconds(turnSeconds);
      showToast('Sua vez.');
    }, OPPONENT_THINKING_FALLBACK_MS);

    scheduleBotStep(randomDelay(3000, 5000), () => {
      const botAction = planBotTurn(gameRef.current);

      if (botAction.recycled) {
        showRecycleEffect();
      }

      if (botAction.action === 'wait') {
        if (!botAction.blocked) {
          setGame(botAction.game);
        }
        resetOpponentState();
        setSeconds(turnSeconds);
        showToast('Monte aguardando novo descarte.');
        return;
      }

      if (botAction.blocked) {
        logGameEvent(MATCH_EVENTS.INVALID_ACTION_BLOCKED, {
          game: gameRef.current,
          actor: 'bot',
          reason: botAction.reason,
        });
        resetOpponentState();
        setSeconds(turnSeconds);
        showToast('Acao do oponente bloqueada pelo motor.');
        return;
      }

      setBotPhase('thinking');
      const from = getLocalBox(botAction.drawSource === 'discard' ? discardRef.current : drawRef.current);
      const to = getOpponentTargetBox();
      const botDrawFlight = makeFlight({
        kind: botAction.drawSource === 'discard' ? 'draw-discard' : 'draw',
        card: botAction.drawnCard,
        faceDown: botAction.drawSource !== 'discard',
        from,
        to,
        fromRotate: botAction.drawSource === 'discard' ? 4 : -7,
        toRotate: 0,
      });

      const continueAfterBotDraw = () => {
        setGame(botAction.afterDrawGame);
        setLastAction(botAction.drawSource === 'discard' ? 'bot-take-discard' : 'bot-draw');
        setIncomingCardId(null);
        logGameEvent(MATCH_EVENTS.CARD_DRAWN, {
          game: botAction.afterDrawGame,
          actor: 'bot',
          extra: {
            source: botAction.drawSource === 'discard' ? 'discard' : 'stock',
            cardId: botAction.drawnCard.id,
          },
        });
        addActionHistory(
          botAction.drawSource === 'discard'
            ? `Oponente comprou ${formatCardLabel(botAction.drawnCard)} do descarte`
            : 'Oponente comprou do monte',
        );

        if (botAction.action === 'bot-knock') {
          scheduleBotStep(randomDelay(360, 520), () => {
            setBotPhase('knocking');
            showBeatImpact();
            addActionHistory('Oponente bateu');
            showToast('Oponente bateu!');

            if (resultTimeoutRef.current) {
              window.clearTimeout(resultTimeoutRef.current);
            }

            resultTimeoutRef.current = window.setTimeout(() => {
              setGame(botAction.game);
              setMatchMeta((current) => ({
                ...current,
                finishedAt: Date.now(),
              }));
              logGameEvent(MATCH_EVENTS.PLAYER_KNOCKED, {
                game: botAction.game,
                actor: 'bot',
                reason: 'bot_win',
              });
              logGameEvent(MATCH_EVENTS.MATCH_FINISHED, {
                game: botAction.game,
                actor: 'bot',
                reason: 'bot_win',
              });
              resetOpponentState();
            }, BEAT_CONFIRM_MS);
          });
          return;
        }

        scheduleBotStep(randomDelay(320, 500), () => {
          setBotPhase('discarding');
          setGame(botAction.game);
          setLastAction('bot-discard');
          setIncomingCardId(null);
          setMatchMeta((current) => ({
            ...current,
            turnsPlayed: current.turnsPlayed + 1,
          }));
          logGameEvent(MATCH_EVENTS.CARD_DISCARDED, {
            game: botAction.game,
            actor: 'bot',
            extra: { cardId: botAction.discardedCard.id },
          });
          logGameEvent(MATCH_EVENTS.TURN_CHANGED, {
            game: botAction.game,
            actor: botAction.game.currentTurn,
          });
          addActionHistory(`Oponente descartou ${formatCardLabel(botAction.discardedCard)}`);

          scheduleBotStep(260, () => {
            resetOpponentState();
            setSeconds(turnSeconds);
            showToast('Oponente descartou. Sua vez.');
          });
        });
      };

      scheduleFlight(botDrawFlight, continueAfterBotDraw, { commitDelay: FLIGHT_COMMIT_MS, clearDelay: FLIGHT_CLEAR_MS });
    });

    return () => {
      if (opponentThinkingFallbackRef.current) {
        window.clearTimeout(opponentThinkingFallbackRef.current);
        opponentThinkingFallbackRef.current = null;
      }
      clearBotSequence();
    };
  }, [
    addActionHistory,
    clearBotSequence,
    getLocalBox,
    getOpponentTargetBox,
    isLocalMultiplayer,
    logGameEvent,
    makeFlight,
    playerTurn,
    result,
    resetOpponentState,
    scheduleBotStep,
    scheduleFlight,
    showBeatImpact,
    showRecycleEffect,
    showToast,
    turnSeconds,
  ]);

  const topDiscard = game.discardPile[game.discardPile.length - 1];
  const canRecycleDraw = game.drawPile.length > 0 || game.discardPile.length > 1;
  const canDraw = canPlayerAct && !handDragging && !hasDrawn && canRecycleDraw && activeCards.length < 10;
  const canTapDraw = canDraw;
  const canTakeDiscard =
    canPlayerAct &&
    !handDragging &&
    !hasDrawn &&
    activeCards.length < 10 &&
    Boolean(topDiscard) &&
    topDiscard.discardedBy !== activeActor;
  const canDropDiscard = canPlayerAct && activeCards.length === 10;
  const canAttemptTestModeBeat = isTestMode
    && !isLocalMultiplayer
    && activeHumanTurn
    && !handDragging
    && !isResolvingAction
    && !resolvingActionRef.current
    && !result;
  const canKnockNow = (
    isTestMode && !isLocalMultiplayer
      ? canAttemptTestModeBeat
      : canPlayerAct && !handDragging
  ) && activeCards.length === 10 && knockValidation.valid;
  const interactionLocked = Boolean(result)
    || !activeHumanTurn
    || turnTransitioning
    || handDragging
    || isResolvingAction
    || resolvingActionRef.current;
  const actionPending = Boolean(turnTransitioning || isResolvingAction || resolvingActionRef.current);
  const discardPending = Boolean(departingCardId || dragDiscardState.active || dragDiscardState.over);

  useEffect(() => {
    if (!isTestMode || isLocalMultiplayer) return;

    const logKey = [
      currentTurn,
      activeCards.length,
      canKnockNow,
      interactionLocked,
      actionPending,
      discardPending,
    ].join('|');
    if (testModeInteractionLockLogRef.current === logKey) return;
    testModeInteractionLockLogRef.current = logKey;

    console.info('TEST_MODE_INTERACTION_LOCK_CHANGED', {
      playerTurn: Boolean(activeHumanTurn),
      handSize: activeCards.length,
      canBeat: Boolean(canKnockNow),
      interactionLocked,
      actionPending,
      discardPending,
    });
  }, [
    actionPending,
    activeCards.length,
    activeHumanTurn,
    canKnockNow,
    currentTurn,
    discardPending,
    interactionLocked,
    isLocalMultiplayer,
    isTestMode,
  ]);

  useEffect(() => {
    if (!isTestMode || isLocalMultiplayer) return;

    const logKey = `${currentTurn}|${matchMeta.turnsPlayed}|${game.turnStage}`;
    if (testModeTurnLogRef.current === logKey) return;
    testModeTurnLogRef.current = logKey;

    console.info('TEST_MODE_TURN_CHANGED', {
      playerTurn: Boolean(activeHumanTurn),
      handSize: activeCards.length,
      canBeat: Boolean(canKnockNow),
      interactionLocked,
      actionPending,
      discardPending,
    });
  }, [
    actionPending,
    activeCards.length,
    activeHumanTurn,
    canKnockNow,
    currentTurn,
    discardPending,
    game.turnStage,
    interactionLocked,
    isLocalMultiplayer,
    isTestMode,
    matchMeta.turnsPlayed,
  ]);

  useEffect(() => {
    if (!isTestMode || isLocalMultiplayer) return;
    console.info('TEST_MODE_BAT_EVALUATED', {
      handSize: activeCards.length,
      isPlayerTurn: Boolean(activeHumanTurn),
      validGroupCount: testModeBatEvaluation.validGroupCount ?? testModeBatEvaluation.validGroups.length,
      groupedCardCount: testModeBatEvaluation.groupedCardCount ?? testModeBatEvaluation.markedCardIds.length,
      remainingCardCount: testModeBatEvaluation.remainingCardCount ?? testModeBatEvaluation.remainingCards.length,
      canBat: Boolean(canKnockNow),
      interactionLocked,
      actionPending,
      discardPending,
    });
  }, [
    actionPending,
    activeCardSignature,
    activeCards.length,
    activeHumanTurn,
    canKnockNow,
    discardPending,
    interactionLocked,
    isLocalMultiplayer,
    isTestMode,
    testModeBatEvaluation.groupedCardCount,
    testModeBatEvaluation.markedCardIds.length,
    testModeBatEvaluation.remainingCardCount,
    testModeBatEvaluation.remainingCards.length,
    testModeBatEvaluation.validGroupCount,
    testModeBatEvaluation.validGroups.length,
  ]);

  useEffect(() => {
    if (typeof window === 'undefined') return;

    window.__PIFE_DUELO_PHASE3_STATE__ = createGameStateSnapshot({
      game,
      matchId: matchMeta.matchId,
      startedAt: matchMeta.startedAt,
      finishedAt: matchMeta.finishedAt,
      turnsPlayed: matchMeta.turnsPlayed,
      turnState: createTurnState({
        game,
        turnStartedAt: matchMeta.startedAt,
        turnDuration: turnSeconds,
        isResolvingAction,
        isDragging: handDragging,
        canDraw,
        canDiscard: canDropDiscard,
        canKnock: canKnockNow,
      }),
    });
  }, [
    canDraw,
    canDropDiscard,
    canKnockNow,
    game,
    handDragging,
    isResolvingAction,
    matchMeta.finishedAt,
    matchMeta.matchId,
    matchMeta.startedAt,
    matchMeta.turnsPlayed,
    turnSeconds,
  ]);

  const showTestModeEndGameReveal = Boolean(isTestMode && result?.reason === 'knock');

  return (
    <main className="game-shell">
      <section className="phone-table wood-frame" aria-label="Pife Duelo V1">
        <button
          type="button"
          className="chrome-button menu-button"
          aria-label="Menu"
          onClick={isTestMode ? openTestModeMenu : undefined}
        >
          <span />
          <span />
          <span />
        </button>
        <button type="button" className="chrome-button settings-button" aria-label="Nova partida" onClick={restart} title="Nova partida">
          {"\u21bb"}
        </button>
        <AudioToggle />
        <div
          ref={tableRef}
          onPointerDown={cancelCardSelection}
          className={`felt-table ${turnTransitioning ? 'is-action-animating' : ''} ${handDragging ? 'is-hand-dragging' : ''} ${beatImpact ? 'table-beat-impact' : ''} ${turnCue ? `turn-cue-${turnCue.target}` : ''}`}
        >
          <div className="table-texture" aria-hidden="true" />
          <div className="table-light" aria-hidden="true" />
          <div className="table-vignette" aria-hidden="true" />
          <div className="table-ambience" aria-hidden="true" />
          <div className="felt-logo" aria-hidden="true">
            <span>{"\u2660 \u2665 \u2666 \u2663"}</span>
            <strong>PIFE</strong>
            <small>DUELO</small>
          </div>
          {debugScenarioKey ? <span className="debug-badge">AUDIT: {debugScenarioKey}</span> : null}
          {turnCue ? <span key={turnCue.id} className="turn-ripple" aria-hidden="true" /> : null}
          <CardFlightLayer flight={flight} />
          <ActionHistory actions={actionHistory} />
          <GameModal
            result={showTestModeEndGameReveal ? null : result}
            onRestart={restart}
            isTestMode={isTestMode}
            onExitToMenu={() => exitTestMode({ target: 'menu' })}
            onGoToPaidFlow={goToPaidFlowFromTestMode}
          />
          <EndGameReveal
            isOpen={showTestModeEndGameReveal}
            result={result}
            matchId={matchMeta.matchId}
            currentPlayerId="player"
            onNewMatch={restart}
            isTestModePostMatch={showTestModeEndGameReveal}
            onOpenWhatsApp={openWhatsAppFromTestMode}
            onCopyWhatsAppLink={copyWhatsAppLinkFromTestMode}
            onExitToMenu={() => exitTestMode({ target: 'menu' })}
            whatsAppLink={buildWhatsAppPlayLink()}
          />
          {isTestMode && testMenuMode ? (
            <div
              className="match-menu-overlay"
              role="dialog"
              aria-modal="true"
              aria-label="Menu do modo teste"
              onPointerDown={(event) => {
                if (event.target === event.currentTarget) closeTestModeMenu({ action: 'continue' });
              }}
            >
              {testMenuMode === 'menu' ? (
                <aside className="match-menu-panel test-mode-menu-panel">
                  <header>
                    <div>
                      <span>Pife Duelo — Modo Teste</span>
                      <h2>Menu</h2>
                    </div>
                    <button
                      type="button"
                      className="test-mode-menu-close"
                      onClick={() => closeTestModeMenu({ action: 'continue' })}
                    >
                      Fechar
                    </button>
                  </header>
                  <div className="test-mode-menu-info">
                    <span>Modo gratuito</span>
                    <span>Sem Pix</span>
                    <span>Sem aposta</span>
                    <span>Sem prêmio</span>
                    <span>Apenas para conhecer a gameplay</span>
                    <span>18+ / jogue com responsabilidade</span>
                  </div>
                  <button type="button" className="test-mode-menu-primary" onClick={() => closeTestModeMenu({ action: 'continue' })}>Continuar jogando</button>
                  <button type="button" onClick={showTestModeRules}>Regras rápidas</button>
                  <button type="button" onClick={restartTestFromMenu}>Reiniciar teste</button>
                  <button type="button" onClick={goToPaidFlowFromTestMenu}>Jogar valendo</button>
                  <button type="button" className="danger" onClick={exitTestFromMenu}>Sair do teste / Voltar ao início</button>
                </aside>
              ) : null}

              {testMenuMode === 'rules' ? (
                <section className="match-rules-panel test-mode-rules-panel">
                  <header>
                    <button type="button" onClick={() => setTestMenuMode('menu')}>Voltar</button>
                    <h2>Regras rápidas</h2>
                  </header>
                  <div className="match-rules-content">
                    <ul>
                      <li>Forme trincas ou sequências.</li>
                      <li>Organize suas cartas.</li>
                      <li>Compre do monte ou descarte.</li>
                      <li>Descarte uma carta.</li>
                      <li>Bata quando sua mão estiver completa.</li>
                    </ul>
                    <p>Modo gratuito, sem Pix, sem aposta e sem prêmio.</p>
                    <p>🔞 Apenas para maiores de 18 anos. Jogue com responsabilidade.</p>
                  </div>
                </section>
              ) : null}
            </div>
          ) : null}

          <OpponentHand
            count={waitingCards.length}
            playerName={waitingName}
            isThinking={opponentThinking}
            isActive={!isLocalMultiplayer && !playerTurn && !result}
            isDrawing={false}
            isDiscarding={botPhase === 'discarding'}
            thinkingLabel="Oponente pensando"
            statusLabel={!isLocalMultiplayer && !playerTurn && !result ? 'Adversario' : 'Aguarde'}
            statusTone={!isLocalMultiplayer && !playerTurn && !result ? 'opponent' : 'muted'}
          />

          <section className="center-zone" aria-label="Centro da mesa">
            <Timer
              seconds={seconds}
              maxSeconds={turnSeconds}
              variant="table"
              label={turnBannerLabel}
            />
            <DeckArea
              drawCount={game.drawPile.length}
              discardCards={game.discardPile}
              canDraw={canDraw}
              canTapDraw={canTapDraw}
              canTakeDiscard={canTakeDiscard}
              onDraw={drawCardForPlayer}
              onTakeDiscard={takeDiscardForPlayer}
              lastAction={lastAction}
              drawRef={drawRef}
              discardRef={discardRef}
              canDropDiscard={canDropDiscard}
              isDragTarget={dragDiscardState.active}
              isDragOver={dragDiscardState.over}
              isRecycling={isRecycling}
              selectedCardId={selectedCardId}
              onDiscardSelected={discardCardById}
            />
          </section>

          <BeatButton canBeat={canKnockNow} onBeat={knock} isAnimating={beatImpact || isResolvingAction} />

          <section className="bottom-zone" aria-label="Area do jogador">
            <PlayerHand
              key={isLocalMultiplayer ? activeActor : 'player-hand'}
              cards={activeCards}
              playerName={activeName}
              statusLabel={activeHumanTurn && !result ? 'Sua vez' : 'Aguarde'}
              statusTone={activeHumanTurn && !result ? 'player' : 'muted'}
              selectedCardId={selectedCardId}
              onSelectCard={(cardId) =>
                setSelectedCardId((current) => (current === cardId ? null : cardId))
              }
              isActive={activeHumanTurn && !result}
              entryFromDeck={lastAction === 'player-draw'}
              entryFromDiscard={lastAction === 'player-take-discard'}
              incomingCardId={incomingCardId}
              canReorder={activeHumanTurn && !turnTransitioning && !result}
              onReorderCard={reorderCardByDrop}
              canDiscard={canDropDiscard}
              onDiscardDragEnd={handleCardDiscardDragEnd}
              onDiscardDragState={handleCardDiscardDragState}
              onHandDragState={handleHandDragState}
              winningCardIds={winningCardIds}
              departingCardId={departingCardId}
            />
          </section>
        </div>
      </section>
    </main>
  );
}
