// Presentation only: callers supply authoritative amounts and provider payloads.
export function currency(cents) {
  return `R$ ${(Number(cents) / 100).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export function balanceMessage(account) {
  return ['💰 *Seu saldo*', '', currency(account.available_balance_cents)].join('\n');
}

export function walletMenu(account) {
  return ['💰 *Carteira*', '', `Saldo: ${currency(account.available_balance_cents)}`, '',
    '1 — Depositar', '2 — Extrato', '3 — Saldo', '4 — Perfil', '0 — Voltar'].join('\n');
}

export const depositPrompt = () => ['💠 *Depositar*', '', 'Qual valor deseja adicionar?',
  'Envie o valor, por exemplo: 5,00.', '', '0 — Voltar'].join('\n');
export const expiredPixMessage = () => ['⌛ *Pix expirado*', '', 'Esta cobrança não está mais disponível.',
  'Gere um novo Pix para continuar.', '', '1 — Gerar novo Pix', '0 — Voltar'].join('\n');
export const insufficientBalanceMessage = () => ['💸 *Saldo insuficiente*', '',
  'Recarregue para continuar.', '', '1 — Recarregar', '0 — Voltar'].join('\n');
export const pixFailureMessage = () => 'Não foi possível gerar o Pix agora. Tente novamente em instantes.';
export const unavailableWalletMessage = () => 'A carteira está indisponível no momento. Tente novamente em instantes.';
export const unavailableWithdrawalMessage = () => 'Saque indisponível no momento.';

export function pixMessage(order, minutes) {
  return ['💠 *Pix gerado*', '', `Valor: ${currency(order.amount_cents)}`, '',
    'Copie o código Pix completo abaixo e cole no aplicativo do banco.', '',
    `⏱️ Válido por ${minutes} minutos.`, '', order.pix_copy_paste].join('\n');
}

export function paymentConfirmationMessage({ amountCents, newBalanceCents }) {
  return ['✅ *Pagamento confirmado*', '', `${currency(amountCents)} adicionados à sua carteira.`, '',
    `Saldo: ${currency(newBalanceCents)}`].join('\n');
}

const HISTORY_LABELS = Object.freeze({
  DEPOSIT_CREDITED: 'Depósito', DEPOSIT_REFUNDED: 'Depósito devolvido', DEPOSIT_REVERSED: 'Depósito devolvido',
  MATCH_STAKE_RESERVED: 'Entrada na partida', MATCH_STAKE_RELEASED: 'Entrada devolvida',
  MATCH_SETTLED: 'Resultado da partida', WITHDRAWAL_REQUESTED: 'Saque solicitado',
  WITHDRAWAL_REJECTED: 'Saque devolvido',
});

export function historyMessage(history) {
  // Only available-balance entries represent changes to the balance displayed here.
  // Pending and counterpart entries would otherwise show the same deposit twice.
  const entries = history.filter((item) => item.ledger_account === 'PLAYER_AVAILABLE');
  return ['📋 *Extrato*', '', ...(entries.length ? entries.map((item) =>
    `${Number(item.amount_cents) < 0 ? '−' : '+'} ${currency(Math.abs(Number(item.amount_cents)))}  ${HISTORY_LABELS[item.transaction_type] || 'Movimentação'}`)
    : ['Nenhuma movimentação disponível.']), '', '0 — Voltar'].join('\n');
}
