const TRUE_VALUES = new Set(['1', 'true', 'yes', 'on']);

function bool(value, fallback = false) {
  if (value === undefined || value === null || value === '') return fallback;
  return TRUE_VALUES.has(String(value).trim().toLowerCase());
}

function positiveInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function list(value) {
  return [...new Set(String(value || '').split(',').map((item) => item.replace(/\D/g, '')).filter(Boolean))];
}

export function resolveFinancialConfig(env = process.env) {
  const mode = String(env.FINANCIAL_MODE || 'sandbox').trim().toLowerCase();
  const provider = String(env.PAYMENT_PROVIDER || 'mock').trim().toLowerCase();
  const config = {
    enabled: bool(env.FINANCIAL_WALLET_ENABLED),
    mode,
    provider,
    pixDepositsEnabled: bool(env.PIX_DEPOSITS_ENABLED),
    realMoneyGamesEnabled: bool(env.REAL_MONEY_GAMES_ENABLED),
    withdrawalsEnabled: bool(env.WITHDRAWALS_ENABLED),
    withdrawalMode: String(env.WITHDRAWAL_MODE || 'manual').trim().toLowerCase(),
    autoWithdrawalsEnabled: bool(env.AUTO_WITHDRAWALS_ENABLED),
    minWithdrawalAmountCents: positiveInteger(env.MIN_WITHDRAWAL_AMOUNT_CENTS, 2000),
    databaseUrl: String(env.DATABASE_URL || '').trim(),
    encryptionKey: String(env.FINANCIAL_DATA_ENCRYPTION_KEY || '').trim(),
    asaasApiKey: String(env.ASAAS_API_KEY || '').trim(),
    asaasWebhookToken: String(env.ASAAS_WEBHOOK_TOKEN || '').trim(),
    asaasSandboxTestCpfCnpj: String(env.ASAAS_SANDBOX_TEST_CPF_CNPJ || '').trim(),
    financialAdminNumbers: list(env.WHATSAPP_FINANCIAL_ADMIN_NUMBERS),
    asaasBaseUrl: mode === 'production' ? 'https://api.asaas.com/v3' : 'https://api-sandbox.asaas.com/v3',
    pixPaymentWindowMinutes: positiveInteger(env.PIX_PAYMENT_WINDOW_MINUTES, 10),
  };
  const errors = [];
  if (!['sandbox', 'production'].includes(mode)) errors.push('FINANCIAL_MODE_INVALID');
  if (!['mock', 'asaas'].includes(provider)) errors.push('PAYMENT_PROVIDER_INVALID');
  if (!['manual'].includes(config.withdrawalMode)) errors.push('WITHDRAWAL_MODE_UNSAFE');
  if (config.autoWithdrawalsEnabled) errors.push('AUTO_WITHDRAWALS_NOT_SUPPORTED');
  if (config.enabled && !config.databaseUrl) errors.push('FINANCIAL_DATABASE_REQUIRED');
  if (config.enabled && config.withdrawalsEnabled && config.encryptionKey.length < 32) errors.push('FINANCIAL_ENCRYPTION_KEY_REQUIRED');
  if (config.enabled && config.withdrawalsEnabled && config.financialAdminNumbers.length === 0) errors.push('FINANCIAL_ADMIN_REQUIRED');
  if (config.enabled && config.pixDepositsEnabled && provider === 'asaas' && !config.asaasApiKey) errors.push('ASAAS_API_KEY_REQUIRED');
  if (config.enabled && config.pixDepositsEnabled && !config.asaasWebhookToken) errors.push('ASAAS_WEBHOOK_TOKEN_REQUIRED');
  if (mode === 'production') {
    if (config.enabled) errors.push('PRODUCTION_FINANCIAL_ACTIVATION_REQUIRES_RELEASE');
    if (provider === 'mock') errors.push('PRODUCTION_MOCK_PROVIDER_FORBIDDEN');
    if (config.asaasApiKey && !config.asaasApiKey.startsWith('$aact_prod_')) errors.push('ASAAS_PRODUCTION_KEY_MISMATCH');
    if (!config.asaasWebhookToken || config.asaasWebhookToken.length < 32) errors.push('PRODUCTION_WEBHOOK_TOKEN_WEAK');
    if (config.realMoneyGamesEnabled && !config.enabled) errors.push('REAL_MONEY_REQUIRES_WALLET');
  }
  if (mode === 'sandbox' && config.asaasApiKey && !config.asaasApiKey.startsWith('$aact_hmlg_')) {
    errors.push('ASAAS_SANDBOX_KEY_MISMATCH');
  }
  if (!config.enabled && (config.pixDepositsEnabled || config.realMoneyGamesEnabled || config.withdrawalsEnabled)) {
    errors.push('FINANCIAL_FEATURE_REQUIRES_WALLET');
  }
  return { ...config, errors, ready: config.enabled && errors.length === 0 };
}

export function assertFinancialConfig(config) {
  if (config.enabled && config.errors.length) throw new Error(`FINANCIAL_CONFIG_INVALID:${config.errors.join(',')}`);
  return config;
}
