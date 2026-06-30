import { AnimatePresence, motion } from 'framer-motion';
import { formatMoney } from '../shared/economy.js';

export default function GameModal({
  result,
  onRestart,
  isTestMode = false,
  onExitToMenu,
  onGoToPaidFlow,
}) {
  const winner = result?.winner ?? (result?.type === 'win' ? 'player' : 'bot');
  const economy = result?.economy;
  const economicResult = result?.economicResult;
  const showEconomy = !isTestMode && Boolean(economy || economicResult);
  const testModeWon = isTestMode && (result?.type === 'win' || winner === 'player');
  const title = isTestMode
    ? testModeWon
      ? '🎉 Parabéns, você venceu!'
      : '😅 Quase lá!'
    : result?.title ?? (result?.type === 'win' ? 'Vitoria' : 'Derrota');
  const message = isTestMode
    ? testModeWon
      ? 'Você já entendeu como o Pife Duelo funciona.\nAgora, se quiser, volte ao WhatsApp e entre em uma mesa valendo.\n\n💰 Jogue com responsabilidade.\n🔞 Apenas para maiores de 18 anos.'
      : 'Você perdeu essa, mas já pegou o jeito do jogo.\nTreine mais uma rodada grátis ou volte ao WhatsApp para jogar valendo quando se sentir pronto.\n\n💰 Jogue com responsabilidade.\n🔞 Apenas para maiores de 18 anos.'
    : result?.message;

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
            <p className="modal-kicker">{isTestMode ? 'Modo Teste grátis' : 'Pife Duelo V1'}</p>
            <h2>{title}</h2>
            <p className="modal-copy">{message}</p>
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
            {isTestMode ? (
              <div className="modal-actions">
                <button type="button" onClick={onRestart}>
                  {testModeWon ? 'Jogar teste novamente' : 'Tentar novamente grátis'}
                </button>
                <button type="button" className="modal-secondary-action" onClick={onGoToPaidFlow}>
                  Jogar valendo
                </button>
                <button type="button" className="modal-ghost-action" onClick={onExitToMenu}>
                  Voltar ao menu
                </button>
              </div>
            ) : (
              <button type="button" onClick={onRestart}>
                Jogar novamente
              </button>
            )}
          </motion.div>
        </motion.div>
      ) : null}
    </AnimatePresence>
  );
}
