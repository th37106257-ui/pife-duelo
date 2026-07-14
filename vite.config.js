import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')
  const publicWhatsAppBotNumber = process.env.VITE_WHATSAPP_BOT_NUMBER
    || env.VITE_WHATSAPP_BOT_NUMBER
    || process.env.WHATSAPP_BOT_NUMBER
    || env.WHATSAPP_BOT_NUMBER
    || ''

  return {
    define: {
      __PIFE_PUBLIC_WHATSAPP_BOT_NUMBER__: JSON.stringify(publicWhatsAppBotNumber)
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
