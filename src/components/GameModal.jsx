import { AnimatePresence, motion } from 'framer-motion';
import { formatMoney } from '../shared/economy.js';

export default function GameModal({ result, onRestart }) {
  const winner = result?.winner ?? (result?.type === 'win' ? 'player' : 'bot');
  const economy = result?.economy;
  const economicResult = result?.economicResult;
  const showEconomy = Boolean(economy || economicResult);

  return (
    <AnimatePresence>
      {result ? (
        <motion.div
          className="game-modal-layer"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
        >
          <motion.div
            className={`game-modal game-modal-${result.type} game-modal-${winner}`}
            initial={{ y: 28, scale: 0.9 }}
            animate={{ y: 0, scale: 1 }}
            exit={{ y: 18, opacity: 0 }}
            transition={{ type: 'spring', stiffness: 260, damping: 24 }}
          >
            <span className="modal-burst" aria-hidden="true">
              <i />
              <i />
              <i />
              <i />
              <i />
              <i />
            </span>
            <span className="modal-emblem" aria-hidden="true">
              {result.emblem ?? (result.type === 'win' ? '\u2666' : '\u2660')}
            </span>
            <p className="modal-kicker">Pife Duelo V1</p>
            <h2>{result.title ?? (result.type === 'win' ? 'Vitoria' : 'Derrota')}</h2>
            <p className="modal-copy">{result.message}</p>
            {showEconomy ? (
              <div className="modal-economy-summary">
                <span>Mesa: {formatMoney(economicResult?.tableValue ?? economy?.tableValue)}</span>
                {result.type === 'win' ? (
                  <>
                    <span>Premio: {formatMoney(economicResult?.winnerPrize ?? economy?.winnerPrize)}</span>
                    <span>Taxa da plataforma: {formatMoney(economicResult?.platformFeeAmount ?? economy?.platformFeeAmount)}</span>
                  </>
                ) : (
                  <span>Vencedor recebeu: {formatMoney(economicResult?.winnerPrize ?? economy?.winnerPrize)}</span>
                )}
              </div>
            ) : null}
            <button type="button" onClick={onRestart}>
              Jogar novamente
            </button>
          </motion.div>
        </motion.div>
      ) : null}
    </AnimatePresence>
  );
}
