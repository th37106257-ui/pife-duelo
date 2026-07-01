import { AnimatePresence, motion } from 'framer-motion';
import Card from './Card.jsx';
import { formatMoney } from '../shared/economy.js';

const GROUP_LABELS = {
  sequencia: 'Sequencia',
  trinca: 'Trinca',
};

export default function EndGameReveal({
  isOpen,
  result,
  currentPlayerId,
  onNewMatch,
  isOnlinePostMatch = false,
  hasWhatsAppReturn = false,
  onOpenWhatsApp,
}) {
  const won = result?.winnerId === currentPlayerId;
  const groups = result?.winningGroups ?? [];
  const remainingCards = result?.remainingCards ?? [];
  const economy = result?.economy;
  const economicResult = result?.economicResult;

  return (
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
            <h2 className="endgame-title">{won ? 'Voce bateu!' : 'Seu adversario bateu'}</h2>
            <p className="endgame-subtitle">
              {won ? 'Sua formacao foi confirmada' : 'Veja a formacao vencedora'}
            </p>

            <div className="endgame-groups">
              {groups.map((group, groupIndex) => (
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
              ))}
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

            <p className="endgame-footer">
              {won ? 'Voce venceu por batida.' : 'Voce perdeu por batida.'}
            </p>
            {isOnlinePostMatch ? (
              <p className="endgame-footer">
                {hasWhatsAppReturn
                  ? 'O resultado foi enviado para seu WhatsApp. Volte para o WhatsApp para jogar novamente.'
                  : 'Sua partida foi encerrada. Você já pode escolher uma mesa novamente.'}
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
            {isOnlinePostMatch ? (
              <div className="modal-actions">
                {hasWhatsAppReturn ? (
                  <button type="button" className="endgame-button" onClick={onOpenWhatsApp}>
                    Abrir WhatsApp
                  </button>
                ) : (
                  <>
                    <button type="button" className="endgame-button" onClick={onNewMatch}>
                      Jogar novamente
                    </button>
                    <button type="button" className="modal-secondary-action" onClick={onNewMatch}>
                      Ver mesas
                    </button>
                  </>
                )}
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
  );
}
