import { memo } from 'react';

function PlayerBalanceOrb({ balance = '1.250' }) {
  return (
    <div className="player-balance-cluster">
      <div className="player-balance-orb">
        <span className="player-balance-ring" aria-hidden="true" />
        <span className="player-balance-coin" aria-hidden="true">
          $
        </span>
      </div>
      <div className="player-balance-value">
        <span>SALDO</span>
        <strong>{balance}</strong>
      </div>
    </div>
  );
}

export default memo(PlayerBalanceOrb);
