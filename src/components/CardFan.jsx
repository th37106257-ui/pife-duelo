import { AnimatePresence, motion } from 'framer-motion';
import { memo, useEffect, useMemo, useRef, useState } from 'react';
import Card from './Card.jsx';

const HAND_LAYOUT_LIMITS = {
  maxRotation: 6,
  maxCurve: 16,
};

const REORGANIZE_DURATION = 0.18;
const REORGANIZE_STAGGER = 0.01;
const REORGANIZE_LOCK_MS = 220;
const HAND_GAP_SHIFT = 24;
const DESKTOP_DRAG_THRESHOLD = 5;
const MOBILE_DRAG_THRESHOLD = 10;
const DEFAULT_VIEWPORT_WIDTH = 390;
const EMPTY_DRAG_LAYER = {
  card: null,
  x: 0,
  y: 0,
  width: 0,
  height: 0,
};

function getScale(index, count, variant) {
  if (variant !== 'opponent' || count <= 1) return 1;
  const center = (count - 1) / 2;
  const distance = Math.abs(index - center);
  const centerWeight = 1 - distance / Math.max(center, 1);
  return 0.94 + centerWeight * 0.06;
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function getDragThreshold() {
  if (typeof window === 'undefined') return MOBILE_DRAG_THRESHOLD;
  return window.matchMedia?.('(pointer: coarse)').matches ? MOBILE_DRAG_THRESHOLD : DESKTOP_DRAG_THRESHOLD;
}

function getViewportWidth() {
  if (typeof window === 'undefined') return DEFAULT_VIEWPORT_WIDTH;
  return window.innerWidth || DEFAULT_VIEWPORT_WIDTH;
}

function getResponsivePlayerHandStyle(count, viewportWidth) {
  if (count <= 0) {
    return {
      '--card-count': count,
    };
  }

  const safeWidth = Math.min(Math.max(viewportWidth - 30, 310), 410);
  const cardWidth = clamp(viewportWidth * 0.25, viewportWidth < 380 ? 88 : 92, 108);
  const maxStep = cardWidth * 0.36;
  const availableStep = count > 1 ? (safeWidth - cardWidth) / (count - 1) : 0;
  const step = count > 1 ? Math.min(Math.max(availableStep, 0), maxStep) : 0;
  const width = count > 1 ? cardWidth + step * (count - 1) : cardWidth;
  const overlap = count > 1 ? Math.max(cardWidth - step, 0) : 0;

  return {
    '--card-count': count,
    '--card-w': `${cardWidth}px`,
    '--card-overlap': `${overlap}px`,
    width: `${Math.min(width, safeWidth)}px`,
  };
}

function rebuildHandLayout(cards, variant = 'player') {
  const count = cards.length;
  const middle = (count - 1) / 2;
  const spacing = 0;
  const curve = variant === 'opponent' ? -1.15 : 3.1;
  const rotationFactor = variant === 'opponent' ? 0.72 : 1.28;

  return cards.map((card, index) => {
    const offset = index - middle;
    const centeredWeight = count <= 1 ? 1 : 1 - Math.abs(offset) / Math.max(middle, 1);
    const targetX = offset * spacing;
    const targetY =
      variant === 'opponent'
        ? Math.max(middle - Math.abs(offset), 0) * Math.abs(curve) - 2
        : 0;
    const targetRotation = variant === 'opponent' ? offset * rotationFactor : 0;

    // Reorganizacao central: reconstrói a mão do zero por índice para evitar transform acumulado.
    return {
      card,
      index,
      offset,
      targetX,
      targetY: clamp(targetY, -HAND_LAYOUT_LIMITS.maxCurve, HAND_LAYOUT_LIMITS.maxCurve),
      targetRotation: clamp(targetRotation, -HAND_LAYOUT_LIMITS.maxRotation, HAND_LAYOUT_LIMITS.maxRotation),
      scale: getScale(index, count, variant),
      zIndex: variant === 'opponent'
        ? Math.round(20 + centeredWeight * 18)
        : index + 1,
      depth: variant === 'opponent'
        ? 0.82 + centeredWeight * 0.24
        : 0.72 + index / Math.max(count - 1, 1) * 0.28,
      centeredWeight,
      dragOffset: 0,
      temporaryOffset: 0,
    };
  });
}

function getFrozenLayout(layout, cardRefs) {
  return layout.map((item) => {
    const rect = cardRefs.current.get(item.card.id)?.getBoundingClientRect?.();

    return {
      ...item,
      rect: rect
        ? {
            left: rect.left,
            top: rect.top,
            width: rect.width,
            height: rect.height,
          }
        : null,
    };
  });
}

function CardFan({
  cards,
  selectedCardId,
  onSelectCard,
  faceDown = false,
  variant = 'player',
  isActive = false,
  entryFromDeck = false,
  entryFromDiscard = false,
  incomingCardId,
  canReorder = false,
  onReorderCard,
  canDiscard = false,
  onDiscardDragEnd,
  onDiscardDragState,
  onHandDragState,
  isThinking = false,
  highlightCardIds = [],
  comboHighlightedIds = [],
  departingCardId,
}) {
  const count = cards.length;
  const cardSignature = cards.map((card) => card.id).join('|');
  const handLayout = useMemo(() => rebuildHandLayout(cards, variant), [cardSignature, cards, variant]);
  const fanRef = useRef(null);
  const cardRefs = useRef(new Map());
  const skipClickRef = useRef(false);
  const tapStartRef = useRef(null);
  const pointerDragRef = useRef(null);
  const pointerCleanupRef = useRef(null);
  const dragFrameRef = useRef(null);
  const dragLayerFrameRef = useRef(null);
  const pendingDragLayerRef = useRef(null);
  const dragLayerRef = useRef(null);
  const dragInfoRef = useRef(null);
  const dragStartedRef = useRef(false);
  const latestDragPointRef = useRef(null);
  const dragOriginRef = useRef(null);
  const frozenLayoutRef = useRef(null);
  const [draggingCardId, setDraggingCardId] = useState(null);
  const [dropPreviewIndex, setDropPreviewIndex] = useState(null);
  const dropPreviewIndexRef = useRef(null);
  const [placeholderBox, setPlaceholderBox] = useState(null);
  const [dragLayer, setDragLayer] = useState(EMPTY_DRAG_LAYER);
  const [motionState, setMotionState] = useState('IDLE');
  const [isReorganizing, setIsReorganizing] = useState(false);
  const [viewportWidth, setViewportWidth] = useState(getViewportWidth);
  const activeHandLayout = frozenLayoutRef.current ?? handLayout;
  const handStyle = variant === 'player'
    ? getResponsivePlayerHandStyle(count, viewportWidth)
    : { '--card-count': count };
  const fanClass =
    variant === 'opponent'
      ? `card-fan card-fan-opponent opponent-hand ${isThinking ? 'is-thinking' : ''}`
      : 'card-fan card-fan-player is-unified';

  useEffect(() => {
    if (variant !== 'player') return undefined;

    const handleResize = () => {
      setViewportWidth(getViewportWidth());
    };

    window.addEventListener('resize', handleResize, { passive: true });
    window.addEventListener('orientationchange', handleResize);
    return () => {
      window.removeEventListener('resize', handleResize);
      window.removeEventListener('orientationchange', handleResize);
    };
  }, [variant]);

  useEffect(() => {
    setDraggingCardId(null);
    setDropPreviewIndex(null);
    dropPreviewIndexRef.current = null;
    setPlaceholderBox(null);
    setDragLayer(EMPTY_DRAG_LAYER);
    frozenLayoutRef.current = null;
    dragOriginRef.current = null;
    pointerDragRef.current = null;
    dragStartedRef.current = false;
    latestDragPointRef.current = null;
    onDiscardDragState?.(false, null);
    onHandDragState?.(false);
    setMotionState('REORGANIZING');
    setIsReorganizing(true);
    const timeout = window.setTimeout(() => {
      setMotionState('IDLE');
      setIsReorganizing(false);
    }, REORGANIZE_LOCK_MS);

    return () => window.clearTimeout(timeout);
  }, [cardSignature, onDiscardDragState, onHandDragState]);

  useEffect(
    () => () => {
      if (dragFrameRef.current) {
        window.cancelAnimationFrame(dragFrameRef.current);
      }
      if (dragLayerFrameRef.current) {
        window.cancelAnimationFrame(dragLayerFrameRef.current);
      }
      pointerCleanupRef.current?.();
      pointerCleanupRef.current = null;
      onDiscardDragState?.(false, null);
      onHandDragState?.(false);
    },
    [onDiscardDragState, onHandDragState],
  );

  const getHandDropIndex = (cardId, point) => {
    const remainingCards = cards.filter((card) => card.id !== cardId);
    const frozenLayout = frozenLayoutRef.current;

    for (let index = 0; index < remainingCards.length; index += 1) {
      const frozenItem = frozenLayout?.find((item) => item.card.id === remainingCards[index].id);
      const rect = frozenItem?.rect ?? cardRefs.current.get(remainingCards[index].id)?.getBoundingClientRect?.();
      if (!rect) continue;
      if (point.x < rect.left + rect.width / 2) return index;
    }

    return remainingCards.length;
  };

  const getHandPlaceholderBox = (cardId, targetIndex) => {
    const fanRect = fanRef.current?.getBoundingClientRect?.();
    const frozenLayout = frozenLayoutRef.current;
    const draggedRect = frozenLayout?.find((item) => item.card.id === cardId)?.rect
      ?? cardRefs.current.get(cardId)?.getBoundingClientRect?.();
    if (!fanRect || !draggedRect) return null;

    const remainingCards = cards.filter((card) => card.id !== cardId);
    const referenceCard = remainingCards[Math.min(targetIndex, remainingCards.length - 1)];
    const referenceRect = referenceCard
      ? frozenLayout?.find((item) => item.card.id === referenceCard.id)?.rect
        ?? cardRefs.current.get(referenceCard.id)?.getBoundingClientRect?.()
      : null;
    const gapDirection = targetIndex >= remainingCards.length ? 1 : -1;

    return {
      left: referenceRect
        ? referenceRect.left - fanRect.left + gapDirection * Math.min(HAND_GAP_SHIFT, referenceRect.width * 0.28)
        : draggedRect.left - fanRect.left,
      top: (referenceRect?.top ?? draggedRect.top) - fanRect.top,
      width: draggedRect.width,
      height: draggedRect.height,
    };
  };

  const isPointInsideHand = (point) => {
    const fanRect = fanRef.current?.getBoundingClientRect?.();
    if (!fanRect || !point) return false;

    return (
      point.x >= fanRect.left - 24 &&
      point.x <= fanRect.right + 24 &&
      point.y >= fanRect.top - 36 &&
      point.y <= fanRect.bottom + 36
    );
  };

  const scheduleDragPreview = (cardId, point) => {
    dragInfoRef.current = { cardId, point };
    if (dragFrameRef.current) return;

    dragFrameRef.current = window.requestAnimationFrame(() => {
      dragFrameRef.current = null;
      const dragInfo = dragInfoRef.current;
      if (!dragInfo) return;

      if (canDiscard) {
        onDiscardDragState?.(true, dragInfo.point);
      }
      if (canReorder && isPointInsideHand(dragInfo.point)) {
        const nextIndex = getHandDropIndex(dragInfo.cardId, dragInfo.point);
        if (dropPreviewIndexRef.current !== nextIndex) {
          dropPreviewIndexRef.current = nextIndex;
          setDropPreviewIndex(nextIndex);
          setPlaceholderBox(getHandPlaceholderBox(dragInfo.cardId, nextIndex));
        }
      } else {
        if (dropPreviewIndexRef.current !== null) {
          dropPreviewIndexRef.current = null;
          setDropPreviewIndex(null);
          setPlaceholderBox(null);
        }
      }
    });
  };

  const startStableDrag = (card, point) => {
    const element = cardRefs.current.get(card.id);
    const rect = element?.getBoundingClientRect?.();
    if (!rect) return;

    frozenLayoutRef.current = getFrozenLayout(handLayout, cardRefs);
    dragOriginRef.current = {
      cardId: card.id,
      dx: point.x - rect.left,
      dy: point.y - rect.top,
    };
    dragStartedRef.current = true;
    latestDragPointRef.current = point;
    setMotionState('HAND_DRAG');
    setDraggingCardId(card.id);
    setDragLayer({
      card,
      x: point.x - dragOriginRef.current.dx,
      y: point.y - dragOriginRef.current.dy,
      width: rect.width,
      height: rect.height,
    });
    const initialIndex = cards.findIndex((item) => item.id === card.id);
    dropPreviewIndexRef.current = initialIndex;
    setDropPreviewIndex(initialIndex);
    setPlaceholderBox(getHandPlaceholderBox(card.id, initialIndex));
    onHandDragState?.(true);
  };

  const updateDragLayer = (card, point) => {
    if (!dragOriginRef.current || dragOriginRef.current.cardId !== card.id) return;

    pendingDragLayerRef.current = {
      x: point.x - dragOriginRef.current.dx,
      y: point.y - dragOriginRef.current.dy,
    };

    if (dragLayerFrameRef.current) return;

    dragLayerFrameRef.current = window.requestAnimationFrame(() => {
      dragLayerFrameRef.current = null;
      const pendingLayer = pendingDragLayerRef.current;
      if (!pendingLayer) return;

      dragLayerRef.current?.style.setProperty('--drag-x', `${pendingLayer.x}px`);
      dragLayerRef.current?.style.setProperty('--drag-y', `${pendingLayer.y}px`);
    });
  };

  const clearStableDrag = () => {
    pointerCleanupRef.current?.();
    pointerCleanupRef.current = null;
    setDraggingCardId(null);
    setDropPreviewIndex(null);
    dropPreviewIndexRef.current = null;
    setPlaceholderBox(null);
    setDragLayer(EMPTY_DRAG_LAYER);
    frozenLayoutRef.current = null;
    dragOriginRef.current = null;
    pointerDragRef.current = null;
    dragStartedRef.current = false;
    latestDragPointRef.current = null;
    dragInfoRef.current = null;
    pendingDragLayerRef.current = null;
    onDiscardDragState?.(false, null);
    onHandDragState?.(false);
    if (dragFrameRef.current) {
      window.cancelAnimationFrame(dragFrameRef.current);
      dragFrameRef.current = null;
    }
    if (dragLayerFrameRef.current) {
      window.cancelAnimationFrame(dragLayerFrameRef.current);
      dragLayerFrameRef.current = null;
    }
  };

  const handleManualPointerMove = (card, event) => {
    const pointerDrag = pointerDragRef.current;
    if (!pointerDrag || pointerDrag.cardId !== card.id || pointerDrag.pointerId !== event.pointerId) return;

    const point = { x: event.clientX, y: event.clientY };
    if (
      point.x < -24 ||
      point.x > window.innerWidth + 24 ||
      point.y < -24 ||
      point.y > window.innerHeight + 24
    ) {
      clearStableDrag();
      return;
    }

    const dragDistance = Math.hypot(point.x - pointerDrag.startX, point.y - pointerDrag.startY);
    if (!dragStartedRef.current && dragDistance < getDragThreshold()) return;

    event.preventDefault?.();
    skipClickRef.current = true;
    latestDragPointRef.current = point;
    if (!dragStartedRef.current) {
      startStableDrag(card, point);
    } else {
      updateDragLayer(card, point);
    }
    scheduleDragPreview(card.id, point);
  };

  const finishManualDrag = (card, point) => {
    const dragStarted = dragStartedRef.current;

    if (dragStarted) {
      skipClickRef.current = true;
    }

    if (canDiscard && dragStarted && point && !isPointInsideHand(point)) {
      onDiscardDragEnd?.(card.id, point);
    } else if (canReorder && dragStarted && point && isPointInsideHand(point)) {
      const finalDropIndex = getHandDropIndex(card.id, point);
      const currentIndex = cards.findIndex((item) => item.id === card.id);
      if (currentIndex >= 0 && finalDropIndex !== currentIndex) {
        onReorderCard?.(card.id, finalDropIndex);
      }
    }

    setMotionState(dragStarted ? 'REORGANIZING' : 'RETURNING');
    window.setTimeout(() => setMotionState('IDLE'), 150);
    clearStableDrag();
    window.setTimeout(() => {
      skipClickRef.current = false;
    }, 140);
  };

  const attachPointerListeners = (card) => {
    pointerCleanupRef.current?.();

    const handleMove = (event) => {
      handleManualPointerMove(card, event);
    };
    const handleUp = (event) => {
      const pointerDrag = pointerDragRef.current;
      if (!pointerDrag || pointerDrag.cardId !== card.id || pointerDrag.pointerId !== event.pointerId) return;
      finishManualDrag(card, { x: event.clientX, y: event.clientY });
    };
    const handleCancel = () => {
      tapStartRef.current = null;
      clearStableDrag();
    };

    window.addEventListener('pointermove', handleMove, { passive: false });
    window.addEventListener('pointerup', handleUp);
    window.addEventListener('pointercancel', handleCancel);
    pointerCleanupRef.current = () => {
      window.removeEventListener('pointermove', handleMove);
      window.removeEventListener('pointerup', handleUp);
      window.removeEventListener('pointercancel', handleCancel);
    };
  };

  return (
    <motion.div
      layout={false}
      ref={fanRef}
      className={`${fanClass} ${isActive ? 'is-active' : ''} ${isReorganizing ? 'is-reorganizing' : ''} ${draggingCardId ? 'is-dragging' : ''}`}
      style={handStyle}
    >
      <AnimatePresence initial={false}>
        {variant === 'player' && draggingCardId && placeholderBox ? (
          <motion.span
            className="manual-drop-placeholder"
            aria-hidden="true"
            initial={false}
            animate={{
              x: placeholderBox.left,
              y: placeholderBox.top,
              width: placeholderBox.width,
              height: placeholderBox.height,
              opacity: 1,
            }}
            transition={{ duration: 0.12, ease: [0.22, 1, 0.36, 1] }}
          />
        ) : null}
        {activeHandLayout.map((layout) => {
          const { card, index } = layout;
          const selected = selectedCardId === card.id;
          const highlighted = highlightCardIds.includes(card.id);
          const comboHighlighted = comboHighlightedIds.includes(card.id);
          const departing = departingCardId === card.id;
          const canPlayerDrag = variant === 'player' && !faceDown && (canReorder || canDiscard);
          const draggingIndex = draggingCardId ? cards.findIndex((item) => item.id === draggingCardId) : -1;
          const previewIndex = dropPreviewIndex ?? draggingIndex;
          const shouldOpenRight =
            draggingCardId &&
            draggingCardId !== card.id &&
            draggingIndex >= 0 &&
            previewIndex > draggingIndex &&
            index > draggingIndex &&
            index <= previewIndex;
          const shouldOpenLeft =
            draggingCardId &&
            draggingCardId !== card.id &&
            draggingIndex >= 0 &&
            previewIndex < draggingIndex &&
            index >= previewIndex &&
            index < draggingIndex;
          const baseY = layout.targetY;
          const targetY = baseY;
          const targetRotate = layout.targetRotation;
          const isDragging = draggingCardId === card.id;
          const targetX = layout.targetX + (shouldOpenRight ? -HAND_GAP_SHIFT : shouldOpenLeft ? HAND_GAP_SHIFT : 0);
          const shouldIdle = false;
          const baseScale = layout.scale;
          const center = (count - 1) / 2;
          const isIncomingFromDeck =
            entryFromDeck && variant === 'player' && incomingCardId === card.id;
          const isIncomingFromDiscard =
            entryFromDiscard && variant === 'player' && incomingCardId === card.id;
          const depth = layout.depth;

          return (
            <motion.div
              key={card.instanceId ?? card.id}
              layout={false}
              ref={(element) => {
                if (element) {
                  cardRefs.current.set(card.id, element);
                } else {
                  cardRefs.current.delete(card.id);
                }
              }}
              data-card-id={card.id}
              data-layout-x={targetX}
              data-layout-y={targetY}
              data-layout-rotation={targetRotate}
              data-motion-state={
                isDragging
                  ? 'MANUAL_REORDER'
                  : departing
                    ? 'DISCARDING'
                    : isIncomingFromDeck || isIncomingFromDiscard
                      ? 'DRAWING'
                      : selected
                        ? 'CARD_SELECTED'
                        : motionState
              }
              data-card-control="true"
              className={`card-fan-item ${variant === 'opponent' ? 'opponent-card idle' : ''} ${isActive ? 'turn-active' : ''} ${selected ? 'selected-card-item' : ''} ${canPlayerDrag ? 'discard-draggable' : ''} ${highlighted ? 'winning-card' : ''} ${departing ? 'departing-card' : ''} ${isDragging ? 'dragging-card' : ''}`}
              style={{
                '--card-index': index,
                '--card-depth': depth,
                '--shine-opacity': variant === 'player' ? 0.42 + depth * 0.16 : 0.38,
                '--shadow-x': `${(index - (count - 1) / 2) * 0.55}px`,
                '--overlap-shadow-x': `${index <= center ? -4 : 4}px`,
                zIndex: isDragging ? 120 : selected ? 40 : layout.zIndex,
              }}
              drag={false}
              onPointerDown={(event) => {
                if (variant === 'player' && !faceDown) {
                  tapStartRef.current = {
                    cardId: card.id,
                    x: event.clientX,
                    y: event.clientY,
                  };
                  if (canPlayerDrag) {
                    event.preventDefault();
                    event.currentTarget.setPointerCapture?.(event.pointerId);
                    dragStartedRef.current = false;
                    pointerDragRef.current = {
                      cardId: card.id,
                      pointerId: event.pointerId,
                      startX: event.clientX,
                      startY: event.clientY,
                    };
                    attachPointerListeners(card);
                  }
                }
              }}
              onPointerUp={(event) => {
                const pointerDrag = pointerDragRef.current;
                const wasDragging = dragStartedRef.current;
                if (pointerDrag?.cardId === card.id && pointerDrag.pointerId === event.pointerId) {
                  event.currentTarget.releasePointerCapture?.(event.pointerId);
                  if (wasDragging) {
                    finishManualDrag(card, { x: event.clientX, y: event.clientY });
                  } else {
                    pointerDragRef.current = null;
                  }
                }

                const tapStart = tapStartRef.current;
                tapStartRef.current = null;

                if (!tapStart || tapStart.cardId !== card.id || departing || isReorganizing || wasDragging) return;

                const deltaX = Math.abs(event.clientX - tapStart.x);
                const deltaY = Math.abs(event.clientY - tapStart.y);
                if (variant === 'player' && !faceDown && deltaX < 12 && deltaY < 12 && !skipClickRef.current) {
                  onSelectCard?.(card.id);
                }
              }}
              onPointerCancel={() => {
                tapStartRef.current = null;
                clearStableDrag();
              }}
              whileTap={
                variant === 'player' && !faceDown
                  ? {
                      scale: 1,
                      transition: { duration: 0.12, ease: [0.22, 1, 0.36, 1] },
                    }
                  : undefined
              }
              initial={
                isIncomingFromDeck
                  ? {
                      opacity: 0,
                      x: targetX,
                      y: targetY - 14,
                      scale: 0.96,
                      rotate: targetRotate,
                    }
                  : isIncomingFromDiscard
                    ? {
                        opacity: 0,
                        x: targetX,
                        y: targetY - 12,
                        scale: 0.96,
                        rotate: targetRotate,
                      }
                  : {
                      opacity: 0,
                      y: variant === 'opponent' ? -12 : 18,
                      scale: variant === 'opponent' ? baseScale * 0.96 : 0.92,
                      rotate: variant === 'opponent' ? targetRotate * 0.7 : 0,
                    }
              }
              animate={{
                opacity: 1,
                x: targetX,
                y: targetY,
                scale:
                  isIncomingFromDeck || isIncomingFromDiscard
                    ? [0.96, 1.015, 1]
                    : selected
                      ? 1
                      : baseScale,
                rotate: targetRotate,
              }}
              exit={{
                opacity: 0,
                x: variant === 'player' ? 24 : 28,
                y: variant === 'player' ? -118 : 90,
                scale: variant === 'player' ? 0.86 : 0.78,
                rotate: variant === 'player' ? targetRotate + 4 : -8,
                transition: {
                  duration: variant === 'opponent' ? 0.28 : 0.24,
                  ease: [0.22, 1, 0.36, 1],
                },
              }}
              transition={
                isIncomingFromDeck || isIncomingFromDiscard
                  ? {
                      opacity: { duration: 0.08 },
                      x: { duration: 0.16, ease: [0.22, 1, 0.36, 1] },
                      y: { duration: 0.16, ease: [0.22, 1, 0.36, 1] },
                      scale: { duration: 0.16, ease: [0.22, 1, 0.36, 1] },
                      rotate: { duration: 0.16, ease: [0.22, 1, 0.36, 1] },
                    }
                  : shouldIdle
                  ? {
                      opacity: { duration: 0.25 },
                      scale: {
                        duration: 4.2 + index * 0.07,
                        repeat: Infinity,
                        repeatType: 'mirror',
                        ease: 'easeInOut',
                      },
                      x: {
                        duration: 4.8 + index * 0.08,
                        repeat: Infinity,
                        repeatType: 'mirror',
                        ease: 'easeInOut',
                      },
                      y: {
                        duration: 4.3 + index * 0.08,
                        repeat: Infinity,
                        repeatType: 'mirror',
                        ease: 'easeInOut',
                      },
                      rotate: {
                        duration: 6.4 + index * 0.08,
                        repeat: Infinity,
                        repeatType: 'mirror',
                        ease: 'easeInOut',
                      },
                    }
                  : {
                      type: 'tween',
                      duration: motionState === 'RETURNING' ? 0.15 : Math.min(REORGANIZE_DURATION, 0.2),
                      ease: [0.22, 1, 0.36, 1],
                      delay: variant === 'player' && motionState === 'REORGANIZING'
                        ? Math.min(index * REORGANIZE_STAGGER, 0.12)
                        : 0,
                    }
              }
            >
              <Card
                card={card}
                faceDown={faceDown}
                selected={selected}
                comboHighlighted={variant === 'player' && comboHighlighted}
                onClick={undefined}
                size={variant === 'opponent' ? 'small' : 'responsive'}
                className={variant === 'opponent' ? 'opponent-card-back' : ''}
                interactive={false}
              />
            </motion.div>
          );
        })}
        {variant === 'player' && dragLayer.card ? (
          <div
            key={`drag-layer-${dragLayer.card.instanceId ?? dragLayer.card.id}`}
            ref={dragLayerRef}
            className="hand-drag-layer-card drag-card-overlay"
            aria-hidden="true"
            style={{
              '--drag-x': `${dragLayer.x}px`,
              '--drag-y': `${dragLayer.y}px`,
              width: dragLayer.width,
              height: dragLayer.height,
            }}
          >
            <Card
              card={dragLayer.card}
              faceDown={false}
              selected={selectedCardId === dragLayer.card.id}
              comboHighlighted={false}
              onClick={undefined}
              size="responsive"
              layout={false}
              interactive={false}
            />
          </div>
        ) : null}
      </AnimatePresence>
    </motion.div>
  );
}

export default memo(CardFan);
