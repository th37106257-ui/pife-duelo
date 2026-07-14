import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')
  const publicWhatsAppBotNumber = process.env.VITE_WHATSAPP_BOT_NUMBER
    || env.VITE_WHATSAPP_BOT_NUMBER
    || process.env.WHATSAPP_BOT_NUMBER
    || env.WHATSAPP_BOT_NUMBER
    || ''
  const whatsappFirstLobbyEnabled = String(
    process.env.VITE_WHATSAPP_FIRST_LOBBY_ENABLED
      || env.VITE_WHATSAPP_FIRST_LOBBY_ENABLED
      || process.env.WHATSAPP_FIRST_LOBBY_ENABLED
      || env.WHATSAPP_FIRST_LOBBY_ENABLED
      || 'false'
  ).toLowerCase() === 'true'

  return {
    define: {
      __PIFE_PUBLIC_WHATSAPP_BOT_NUMBER__: JSON.stringify(publicWhatsAppBotNumber),
      __PIFE_WHATSAPP_FIRST_LOBBY_ENABLED__: JSON.stringify(whatsappFirstLobbyEnabled)
    },
    plugins: [react()],
    server: {
      host: '0.0.0.0',
      port: 5173,
      allowedHosts: true
    },
    preview: {
      host: '0.0.0.0',
      port: 5173,
      allowedHosts: true
    }
  }
})
