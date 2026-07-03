try {
  const dotenv = await import('dotenv');
  dotenv.config();
} catch {
  // Permite validar os modulos base antes do npm install em ambientes sem rede.
}

const productionFrontendUrl = 'https://pife-duelo-production-4f73.up.railway.app';
const defaultClientUrl = process.env.NODE_ENV === 'production' ? productionFrontendUrl : 'http://localhost:5173';
const frontendUrl = process.env.FRONTEND_URL || process.env.CLIENT_URL || defaultClientUrl;
const defaultWhatsappEntryStorePath = process.env.NODE_ENV === 'production' ? '/data/whatsapp-entries.json' : '';
const allowedClientUrls = [
  frontendUrl,
  process.env.CLIENT_URL,
  ...(process.env.ALLOWED_CLIENT_URLS || '').split(','),
]
  .map((origin) => String(origin || '').trim())
  .filter(Boolean);
const parseList = (value) => String(value || '').split(',').map((item) => item.trim()).filter(Boolean);
const parseBoolean = (value) => String(value || '').toLowerCase() === 'true';
const normalizePhoneConfig = (value) => {
  const digits = String(value || '').replace(/\D/g, '');
  return digits.length >= 10 && digits.length <= 15 ? digits : '';
};
const parsePhoneList = (...values) => [
  ...new Set(values.flatMap(parseList).map(normalizePhoneConfig).filter(Boolean)),
];

export const config = {
  PORT: Number(process.env.PORT || 3000),
  NODE_ENV: process.env.NODE_ENV || 'development',
  FRONTEND_URL: frontendUrl,
  CLIENT_URL: process.env.CLIENT_URL || frontendUrl,
  ALLOWED_CLIENT_URLS: [...new Set(allowedClientUrls)],
  MAX_PLAYERS_PER_ROOM: 2,
  TURN_DURATION_SECONDS: 60,
  QUEUE_TIMEOUT_SECONDS: 120,
  DISCONNECT_GRACE_SECONDS: Number(process.env.DISCONNECT_GRACE_SECONDS || 60),
  ADMIN_PASSWORD: process.env.ADMIN_PASSWORD || '',
  ADMIN_WHATSAPP_NUMBERS: parsePhoneList(
    process.env.WHATSAPP_ADMIN_NUMBER,
    process.env.ADMIN_WHATSAPP_NUMBER,
    process.env.ADMIN_WHATSAPP_NUMBERS,
    process.env.WHATSAPP_ADMIN_NUMBERS,
  ),
  WHATSAPP_SUPPORT_NUMBER: process.env.WHATSAPP_SUPPORT_NUMBER || '',
  WHATSAPP_PAYMENTS_ENABLED: parseBoolean(process.env.WHATSAPP_PAYMENTS_ENABLED),
  PAYMENT_GATE_ENABLED: parseBoolean(process.env.PAYMENT_GATE_ENABLED),
  WHATSAPP_CONNECTIVITY_TEST_ENABLED: parseBoolean(process.env.WHATSAPP_CONNECTIVITY_TEST_ENABLED),
  WHATSAPP_SAFE_ENTRY_ENABLED: parseBoolean(process.env.WHATSAPP_SAFE_ENTRY_ENABLED),
  WHATSAPP_ENTRY_STORE_PATH: process.env.WHATSAPP_ENTRY_STORE_PATH || defaultWhatsappEntryStorePath,
  WHATSAPP_ENTRY_ACCESS_SECRET: process.env.WHATSAPP_ENTRY_ACCESS_SECRET || '',
  WHATSAPP_ENTRY_EXPIRY_MINUTES: Number(process.env.WHATSAPP_ENTRY_EXPIRY_MINUTES || 60),
  WHATSAPP_ENTRY_ACCESS_TTL_MINUTES: Number(process.env.WHATSAPP_ENTRY_ACCESS_TTL_MINUTES || 180),
  PAYMENT_STORE_PATH: process.env.PAYMENT_STORE_PATH || '',
  PAYMENT_ACCESS_SECRET: process.env.PAYMENT_ACCESS_SECRET || '',
  PAYMENT_EXPIRY_MINUTES: Number(process.env.PAYMENT_EXPIRY_MINUTES || 60),
  PAYMENT_ACCESS_TTL_MINUTES: Number(process.env.PAYMENT_ACCESS_TTL_MINUTES || 180),
  PUBLIC_GAME_URL: process.env.PUBLIC_GAME_URL || frontendUrl,
  EVOLUTION_API_URL: process.env.EVOLUTION_API_URL || '',
  EVOLUTION_API_KEY: process.env.EVOLUTION_API_KEY || '',
  EVOLUTION_INSTANCE_NAME: process.env.EVOLUTION_INSTANCE_NAME || process.env.EVOLUTION_INSTANCE || '',
  EVOLUTION_WEBHOOK_SECRET: process.env.EVOLUTION_WEBHOOK_SECRET || '',
  WHATSAPP_BOT_NUMBER: process.env.WHATSAPP_BOT_NUMBER || '',
  PIX_KEY: process.env.PIX_KEY || '',
  PIX_RECEIVER: process.env.PIX_RECEIVER || '',
  ROOM_MODE: 'duel_1v1',
};

export default config;
