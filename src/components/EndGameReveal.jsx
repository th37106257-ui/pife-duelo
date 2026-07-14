import { Component, useEffect } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import Card from './Card.jsx';
import { reportClientError } from '../services/errorReporter.js';
import { formatMoney } from '../shared/economy.js';

const GROUP_LABELS = {
  sequencia: 'Sequencia',
  trinca: 'Trinca',
};

function isSafeCard(card) {
  return Boolean(card && typeof card === 'object' && (card.id || card.instanceId));
}

function normalizeGroups(rawGroups) {
  if (!Array.isArray(rawGroups)) return [];

  return rawGroups
    .filter((group) => group && typeof group === 'object')
    .map((group) => ({
      type: group.type ?? 'grupo',
      cards: Array.isArray(group.cards) ? group.cards.filter(isSafeCard) : [],
    }))
    .filter((group) => group.cards.length > 0);
}

function normalizeCards(rawCards) {
  return Array.isArray(rawCards) ? rawCards.filter(isSafeCard) : [];
}

class ResultRenderBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error) {
    const payload = {
      matchId: this.props.matchId ?? null,
      reason: this.props.reason ?? null,
      mode: this.props.mode ?? null,
      message: error?.message ?? String(error),
    };
    console.error('MATCH_RESULT_RENDER_FAILED', payload);
    reportClientError(error, 'MATCH_RESULT_RENDER_FAILED', payload);
  }

  render() {
    if (this.state.error) {
      return (
        <div className="endgame-overlay">
          <section className="endgame-panel" aria-label="Resultado da partida">
            <h2 className="endgame-title">Partida finalizada</h2>
            <p className="endgame-subtitle">O jogo terminou, mas houve um erro ao mostrar os detalhes das cartas.</p>
            <p className="endgame-footer">Voce ja pode voltar ao lobby ou abrir o WhatsApp para continuar.</p>
            <div className="modal-actions">
              {this.props.onOpenWhatsApp ? (
                <button type="button" className="endgame-button" onClick={this.props.onOpenWhatsApp}>
                  Jogar pelo WhatsApp
                </button>
              ) : null}
              <button type="button" className="modal-ghost-action" onClick={this.props.onNewMatch}>
                Voltar ao lobby
              </button>
            </div>
          </section>
        </div>
      );
    }

    return this.props.children;
  }
}

export default function EndGameReveal({
  isOpen,
  result,
  matchId = null,
  currentPlayerId,
  onNewMatch,
  isOnlinePostMatch = false,
  isTestModePostMatch = false,
  onOpenWhatsApp,
  onCopyWhatsAppLink,
  onExitToMenu,
  whatsAppLink = '',
}) {
  const won = result?.winnerId === currentPlayerId;
  const groups = normalizeGroups(result?.winningGroups);
  const remainingCards = normalizeCards(result?.remainingCards);
  const economy = result?.economy;
  const economicResult = result?.economicResult;

  useEffect(() => {
    if (!isOpen) return;
    const payload = {
      matchId,
      reason: result?.reason ?? null,
      winnerId: result?.winnerId ?? null,
      currentPlayerId,
      groups: groups.length,
      remainingCards: remainingCards.length,
      mode: isTestModePostMatch ? 'test' : isOnlinePostMatch ? 'online' : 'local',
    };
    console.info('MATCH_RESULT_RENDER_START', payload);
    window.requestAnimationFrame?.(() => {
      console.info('MATCH_RESULT_RENDER_SUCCESS', payload);
    });
  }, [currentPlayerId, groups.length, isOnlinePostMatch, isOpen, isTestModePostMatch, matchId, remainingCards.length, result?.reason, result?.winnerId]);

  const title = isTestModePostMatch
    ? won ? '🎉 Parabéns, você venceu!' : '😅 Quase lá!'
    : won ? 'Voce bateu!' : 'Seu adversario bateu';
  const subtitle = isTestModePostMatch
    ? won
      ? 'Agora que você já conhece o Pife Duelo, volte ao WhatsApp para encontrar uma partida.'
      : 'Você pode tentar novamente ou voltar ao WhatsApp para encontrar uma partida.'
    : won ? 'Sua formacao foi confirmada' : 'Veja a formacao vencedora';

  return (
    <ResultRenderBoundary
      matchId={matchId}
      reason={result?.reason ?? null}
      mode={isTestModePostMatch ? 'test' : isOnlinePostMatch ? 'online' : 'local'}
      onOpenWhatsApp={onOpenWhatsApp}
      onNewMatch={onNewMatch}
    >
      <AnimatePresence>
        {isOpen ? (
          <motion.div
            className="endgame-overlay"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.22, ease: 'easeOut' }}
          >
            <motion.section
              className="endgame-panel"
              aria-label="Resultado da partida"
              initial={{ opacity: 0, y: 12, scale: 0.96 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: 10, scale: 0.97 }}
              transition={{ duration: 0.28, ease: [0.22, 1, 0.36, 1] }}
            >
            <h2 className="endgame-title">{title}</h2>
            <p className="endgame-subtitle">
              {subtitle}
            </p>

            <div className="endgame-groups">
              {groups.length > 0 ? groups.map((group, groupIndex) => (
                <motion.div
                  key={`${group.type}-${groupIndex}`}
                  className="winning-group"
                  style={{ '--group-delay': `${groupIndex * 90}ms` }}
                  initial={{ opacity: 0, y: 14 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{
                    duration: 0.32,
                    delay: 0.12 + groupIndex * 0.09,
                    ease: [0.22, 1, 0.36, 1],
                  }}
                >
                  <span className="group-label">{GROUP_LABELS[group.type] ?? 'Grupo'}</span>
                  <div className="group-cards">
                    {(group.cards ?? []).map((card, cardIndex) => (
                      <motion.div
                        key={card.instanceId ?? card.id}
                        className="endgame-card"
                        initial={{ opacity: 0, y: 12, scale: 0.94 }}
                        animate={{ opacity: 1, y: 0, scale: 1 }}
                        transition={{
                          duration: 0.26,
                          delay: 0.2 + groupIndex * 0.09 + cardIndex * 0.045,
                          ease: [0.22, 1, 0.36, 1],
                        }}
                      >
                        <Card card={card} size="pile" interactive={false} layout={false} />
                      </motion.div>
                    ))}
                  </div>
                </motion.div>
              )) : (
                <div className="winning-group">
                  <span className="group-label">Combinacao vencedora</span>
                  <p className="endgame-footer">A partida foi finalizada, mas a combinacao nao foi enviada completa pelo servidor.</p>
                </div>
              )}
            </div>

            {remainingCards.length > 0 ? (
              <div className="endgame-remaining">
                <span>Cartas restantes</span>
                <div className="group-cards">
                  {remainingCards.map((card) => (
                    <div key={card.instanceId ?? card.id} className="endgame-card endgame-card-muted">
                      <Card card={card} size="pile" interactive={false} layout={false} />
                    </div>
                  ))}
                </div>
              </div>
            ) : null}

            {!isTestModePostMatch ? (
              <p className="endgame-footer">
                {won ? 'Voce venceu por batida.' : 'Voce perdeu por batida.'}
              </p>
            ) : null}
            {isTestModePostMatch ? (
              <>
                <p className="endgame-footer">
                  {won ? 'Voce venceu por batida.' : 'Voce perdeu por batida.'}
                </p>
                <p className="endgame-footer">
                  Não abriu? Copie o link e abra no navegador.
                </p>
              </>
            ) : isOnlinePostMatch ? (
              <p className="endgame-footer">
                Sua partida foi encerrada. Toque em Jogar pelo WhatsApp para escolher uma nova mesa.
              </p>
            ) : null}
            {economy || economicResult ? (
              <div className="endgame-economy-summary">
                <span>Mesa: {formatMoney(economicResult?.tableValue ?? economy?.tableValue)}</span>
                {won ? (
                  <>
                    <span>Premio: {formatMoney(economicResult?.winnerPrize ?? economy?.winnerPrize)}</span>
                    <span>Taxa da plataforma: {formatMoney(economicResult?.platformFeeAmount ?? economy?.platformFeeAmount)}</span>
                  </>
                ) : (
                  <span>Vencedor recebeu: {formatMoney(economicResult?.winnerPrize ?? economy?.winnerPrize)}</span>
                )}
              </div>
            ) : null}
            {isTestModePostMatch ? (
              <div className="modal-actions">
                <button type="button" className="endgame-button" onClick={onOpenWhatsApp}>
                  Jogar pelo WhatsApp
                </button>
                <button type="button" className="modal-secondary-action" onClick={onNewMatch}>
                  Jogar teste novamente
                </button>
                <button type="button" className="modal-ghost-action" onClick={onExitToMenu}>
                  Voltar ao menu
                </button>
                <button type="button" className="modal-ghost-action" onClick={onCopyWhatsAppLink}>
                  Copiar link do WhatsApp
                </button>
                {whatsAppLink ? <small className="endgame-whatsapp-fallback">{whatsAppLink}</small> : null}
              </div>
            ) : isOnlinePostMatch ? (
              <div className="modal-actions">
                <button type="button" className="endgame-button" onClick={onOpenWhatsApp}>
                  Jogar pelo WhatsApp
                </button>
                <button type="button" className="modal-ghost-action" onClick={onNewMatch}>
                  Voltar ao lobby
                </button>
              </div>
            ) : (
              <button type="button" className="endgame-button" onClick={onNewMatch}>
                Nova partida
              </button>
            )}
            </motion.section>
          </motion.div>
        ) : null}
      </AnimatePresence>
    </ResultRenderBoundary>
  );
}
