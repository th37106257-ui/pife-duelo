try {
  const dotenv = await import('dotenv');
  dotenv.config();
} catch {
  // Permite validar os modulos base antes do npm install em ambientes sem rede.
}

const defaultClientUrl = process.env.NODE_ENV === 'production' ? '' : 'http://localhost:5173';

export const config = {
  PORT: Number(process.env.PORT || 3000),
  NODE_ENV: process.env.NODE_ENV || 'development',
  CLIENT_URL: process.env.CLIENT_URL || defaultClientUrl,
  ALLOWED_CLIENT_URLS: (process.env.ALLOWED_CLIENT_URLS || process.env.CLIENT_URL || defaultClientUrl)
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean),
  MAX_PLAYERS_PER_ROOM: 2,
  TURN_DURATION_SECONDS: 60,
  QUEUE_TIMEOUT_SECONDS: 120,
  DISCONNECT_GRACE_SECONDS: Number(process.env.DISCONNECT_GRACE_SECONDS || 60),
  ADMIN_PASSWORD: process.env.ADMIN_PASSWORD || '',
  ROOM_MODE: 'duel_1v1',
};

export default config;
