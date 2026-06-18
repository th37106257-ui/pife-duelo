import { memo, useEffect, useMemo, useRef, useState } from 'react';
import { getRemainingSeconds, normalizeTimeSync } from '../game/serverClock.js';
import { getSocket } from '../services/socket.js';
import Timer from './Timer.jsx';

function OnlineSyncedTimer({ matchId, serverNow, turnStartedAt, turnDurationMs = 60000, label, onSecondChange }) {
  const initialSync = useMemo(() => normalizeTimeSync({
    matchId,
    serverNow,
    turnStartedAt,
    turnDurationMs,
  }), [matchId, serverNow, turnStartedAt, turnDurationMs]);
  const syncRef = useRef(initialSync);
  const callbackRef = useRef(onSecondChange);
  const [seconds, setSeconds] = useState(() => getRemainingSeconds(initialSync));

  useEffect(() => {
    callbackRef.current = onSecondChange;
  }, [onSecondChange]);

  useEffect(() => {
    syncRef.current = initialSync;
    setSeconds(getRemainingSeconds(initialSync));
  }, [initialSync]);

  useEffect(() => {
    const socket = getSocket();
    if (!socket) return undefined;

    const handleTimeSync = (payload) => {
      if (payload.matchId !== matchId) return;
      const nextSync = normalizeTimeSync(payload);
      syncRef.current = nextSync;
      setSeconds(getRemainingSeconds(nextSync));
    };
    socket.on('time_sync', handleTimeSync);
    return () => socket.off('time_sync', handleTimeSync);
  }, [matchId]);

  useEffect(() => {
    let previousSecond = seconds;
    const interval = window.setInterval(() => {
      const nextSecond = getRemainingSeconds(syncRef.current);
      if (nextSecond === previousSecond) return;
      previousSecond = nextSecond;
      setSeconds(nextSecond);
      callbackRef.current?.(nextSecond);
    }, 250);
    return () => window.clearInterval(interval);
  }, [matchId]);

  return (
    <Timer
      seconds={seconds}
      maxSeconds={Math.max(1, Math.round(turnDurationMs / 1000))}
      variant="table"
      label={label}
    />
  );
}

export default memo(OnlineSyncedTimer);
