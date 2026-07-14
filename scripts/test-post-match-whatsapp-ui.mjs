import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createServer } from 'vite';

const vite = await createServer({
  appType: 'custom',
  logLevel: 'silent',
  server: { middlewareMode: true },
});

try {
  const { default: OnlineGameTable } = await vite.ssrLoadModule('/src/components/OnlineGameTable.jsx');
  const baseState = {
    matchId: 'match-post-whatsapp',
    roomId: 'room-post-whatsapp',
    playerId: 'player-a',
    status: 'finished',
    hand: [],
    topDiscardCard: null,
    deckCount: 0,
    isYourTurn: false,
    isResolvingAction: false,
    opponent: { name: 'OPONENTE', handCount: 0 },
    you: { name: 'VOCE' },
  };

  const renderResult = (winnerId) => renderToStaticMarkup(React.createElement(OnlineGameTable, {
    onlineGameState: {
      ...baseState,
      result: {
        reason: 'knock',
        winnerId,
        loserId: winnerId === 'player-a' ? 'player-b' : 'player-a',
        winningGroups: [],
        remainingCards: [],
      },
    },
    actionError: '',
    onLeaveOnline: () => {},
  }));

  const winnerMarkup = renderResult('player-a');
  const loserMarkup = renderResult('player-b');

  assert.match(winnerMarkup, /Voce bateu!/);
  assert.match(loserMarkup, /Seu adversario bateu/);
  assert.match(winnerMarkup, /Jogar pelo WhatsApp/);
  assert.match(loserMarkup, /Jogar pelo WhatsApp/);
  assert.doesNotMatch(winnerMarkup, /resultado foi enviado para seu WhatsApp/i);
  assert.doesNotMatch(loserMarkup, /resultado foi enviado para seu WhatsApp/i);

  console.log('Pos-partida online: vencedor e perdedor recebem CTA direto do WhatsApp.');
} finally {
  await vite.close();
}
