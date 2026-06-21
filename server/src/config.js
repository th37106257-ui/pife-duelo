try {
  const dotenv = await import('dotenv');
  dotenv.config();
} catch {
  // Permite validar os modulos base antes do npm install em ambientes sem rede.
}

const productionFrontendUrl = 'https://pife-duelo-production-4f73.up.railway.app';
const defaultClientUrl = process.env.NODE_ENV === 'production' ? productionFrontendUrl : 'http://localhost:5173';
const frontendUrl = process.env.FRONTEND_URL || process.env.CLIENT_URL || defaultClientUrl;
const allowedClientUrls = [
  frontendUrl,
  process.env.CLIENT_URL,
  ...(process.env.ALLOWED_CLIENT_URLS || '').split(','),
]
  .map((origin) => String(origin || '').trim())
  .filter(Boolean);

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
  ROOM_MODE: 'duel_1v1',
};

export default config;
