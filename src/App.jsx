import React, { useEffect } from 'react'
import ConnectionTest from './components/ConnectionTest.jsx'
import AdminPanel from './components/AdminPanel.jsx'
import GameTable from './components/GameTable.jsx'
import MatchmakingScreen from './components/MatchmakingScreen.jsx'
import { initSoundSystem } from './services/soundEffects.js'

export default function App() {
  useEffect(() => {
    initSoundSystem()
  }, [])

  const params = new URLSearchParams(window.location.search)
  if (params.get('socketTest') === '1') {
    return <ConnectionTest />
  }
  if (window.location.pathname === '/admin') {
    return <AdminPanel />
  }
  if (params.get('online') === '1') {
    return <MatchmakingScreen />
  }

  return <GameTable />
}
