import { memo, useEffect, useState } from 'react';
import { getGameNetworkDebug } from '../services/socket.js';

function isNetworkDebugEnabled() {
  if (typeof window === 'undefined') return false;
  const params = new URLSearchParams(window.location.search);
  return params.get('debug') === 'network' || params.get('networkDebug') === '1';
}

function NetworkDebugBadge() {
  const [enabled] = useState(isNetworkDebugEnabled);
  const [telemetry, setTelemetry] = useState(getGameNetworkDebug);

  useEffect(() => {
    if (!enabled) return undefined;
    const interval = window.setInterval(() => setTelemetry(getGameNetworkDebug()), 1000);
    return () => window.clearInterval(interval);
  }, [enabled]);

  if (!enabled) return null;
  return (
    <output className="network-debug-badge">
      {telemetry.latencyMs ?? '-'}ms · {telemetry.socketTransport ?? '-'} · estado {telemetry.lastStateUpdateAt ? new Date(telemetry.lastStateUpdateAt).toLocaleTimeString('pt-BR') : '-'}
    </output>
  );
}

export default memo(NetworkDebugBadge);
