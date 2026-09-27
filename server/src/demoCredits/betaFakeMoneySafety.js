export function assertBetaFakeMoneySafety({ enabled = false, financialConfig = {} } = {}) {
  if (!enabled) return true;
  if (financialConfig.realMoneyGamesEnabled) throw new Error('BETA_REQUIRES_REAL_MONEY_GAMES_DISABLED');
  if (financialConfig.withdrawalsEnabled) throw new Error('BETA_REQUIRES_WITHDRAWALS_DISABLED');
  if (financialConfig.autoWithdrawalsEnabled) throw new Error('BETA_REQUIRES_AUTO_WITHDRAWALS_DISABLED');
  if (financialConfig.enabled || financialConfig.pixDepositsEnabled) {
    throw new Error('BETA_REQUIRES_FINANCIAL_WALLET_DISABLED');
  }
  return true;
}

export default assertBetaFakeMoneySafety;
