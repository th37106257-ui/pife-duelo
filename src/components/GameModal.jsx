import { useEffect } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { formatMoney } from '../shared/economy.js';

export default function GameModal({
  result,
  onRestart,
  isTestMode = false,
  onExitToMenu,
  onGoToPaidFlow,
  isOnlinePostMatch = false,
  onOpenWhatsApp,
}) {
  const winner = result?.winner ?? (result?.type === 'win' ? 'player' : 'bot');
  const economy = result?.economy;
  const economicResult = result?.economicResult;
  const showEconomy = !isTestMode && Boolean(economy || economicResult);
  const testModeWon = isTestMode && (result?.type === 'win' || winner === 'player');
  const title = isOnlinePostMatch
    ? result?.title ?? '🏆 Partida finalizada'
    : isTestMode
      ? testModeWon
        ? '🎉 Parabéns, você venceu!'
        : '😅 Quase lá!'
      : result?.title ?? (result?.type === 'win' ? 'Vitória' : 'Derrota');
  const message = isOnlinePostMatch
    ? result?.message ?? 'Sua partida foi encerrada.\nToque em Jogar pelo WhatsApp para escolher uma nova mesa.'
    : isTestMode
      ? testModeWon
        ? 'Você já entendeu como o Pife Duelo funciona.\nAgora, se quiser, volte ao WhatsApp e entre em uma mesa valendo.\n\n💰 Jogue com responsabilidade.\n🔞 Apenas para maiores de 18 anos.'
        : 'Você perdeu essa, mas já pegou o jeito do jogo.\nTreine mais uma rodada grátis ou volte ao WhatsApp para jogar valendo quando se sentir pronto.\n\n💰 Jogue com responsabilidade.\n🔞 Apenas para maiores de 18 anos.'
      : result?.message;

  useEffect(() => {
    if (!result || !isOnlinePostMatch) return;
    const payload = {
      matchId: result.matchId ?? null,
      winner: result.winner ?? null,
      type: result.type ?? null,
      mode: 'online',
    };
    console.info('MATCH_RESULT_RENDER_START', payload);
    window.requestAnimationFrame?.(() => {
      console.info('MATCH_RESULT_RENDER_SUCCESS', payload);
    });
  }, [isOnlinePostMatch, result]);

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
              {result.emblem ?? (result.type === 'win' ? '♦' : '♠')}
            </span>
            <p className="modal-kicker">{isTestMode ? 'Modo Teste grátis' : 'Pife Duelo V1'}</p>
            <h2>{title}</h2>
            <p className="modal-copy">{message}</p>
            {showEconomy ? (
              <div className="modal-economy-summary">
                <span>Mesa: {formatMoney(economicResult?.tableValue ?? economy?.tableValue)}</span>
                {result.type === 'win' ? (
                  <>
                    <span>Prêmio: {formatMoney(economicResult?.winnerPrize ?? economy?.winnerPrize)}</span>
                    <span>Taxa da plataforma: {formatMoney(economicResult?.platformFeeAmount ?? economy?.platformFeeAmount)}</span>
                  </>
                ) : (
                  <span>Vencedor recebeu: {formatMoney(economicResult?.winnerPrize ?? economy?.winnerPrize)}</span>
                )}
              </div>
            ) : null}
            {isOnlinePostMatch ? (
              <div className="modal-actions">
                <button type="button" onClick={onOpenWhatsApp}>
                  Jogar pelo WhatsApp
                </button>
                <button type="button" className="modal-secondary-action" onClick={onRestart}>
                  Voltar ao lobby
                </button>
              </div>
            ) : isTestMode ? (
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
