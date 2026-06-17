# Teste Fase 4.4 - Estado Autoritativo

## Checklist

- [x] Match online inicia apos matchmaking
- [x] Servidor cria baralho
- [x] Servidor distribui cartas
- [x] Cada jogador recebe apenas sua mao
- [x] Adversario aparece apenas com quantidade de cartas
- [x] Compra do monte funciona
- [x] Compra do descarte funciona
- [x] Descarte funciona
- [x] Turno troca corretamente
- [x] Acao fora do turno e rejeitada
- [x] Carta invalida e rejeitada
- [x] Compra dupla e rejeitada
- [x] Bater invalido e rejeitado
- [x] Bater valido encerra partida
- [x] Estado sincroniza nos dois navegadores
- [x] Modo local continua funcionando
- [x] Android continua fluido
- [x] Nenhuma mao adversaria e exposta no payload

## Bugs encontrados

1. Identificacao de fase do servidor ainda aparecia como 4.3 depois da implementacao da 4.4.
2. A mesa online ainda nao existia como camada separada do modo local.
3. Era necessario garantir que o payload filtrado nunca enviasse `opponent.hand`.

## Correcoes feitas

1. Atualizada a fase do servidor, `/health`, `/api/status` e logs de inicializacao para 4.4.
2. Criados `buildClientGameState`, `createOnlineMatch` e eventos online autoritativos.
3. Criados `onlineGameSocket.js` e `OnlineGameTable.jsx` como camada isolada do modo local.
4. `matchStarted`, `gameStateUpdated` e `matchFinished` agora enviam payload individual filtrado por jogador.
5. Adicionados bloqueios/rejeicoes para turno errado, compra dupla, carta invalida e bater invalido.

## Evidencias

- Dois clientes Socket.io entraram na mesma mesa e receberam `matchFound`.
- O servidor criou partida online com `ONLINE_MATCH_CREATED` e enviou `MATCH_STARTED`.
- Cada jogador recebeu 9 cartas proprias e apenas `opponent.handCount`.
- `opponent.hand` nao apareceu nos payloads de `matchStarted` nem `gameStateUpdated`.
- Compra do monte reduziu `deckCount` de 33 para 32 e aumentou a mao do jogador para 10.
- O adversario recebeu apenas `opponent.handCount: 10`.
- Compra dupla retornou `ALREADY_DREW`.
- Acao fora do turno retornou `NOT_YOUR_TURN`.
- Carta inexistente retornou `INVALID_CARD`.
- Bater invalido retornou `INVALID_KNOCK`.
- Descarte removeu carta da mao, atualizou `topDiscardCard` e passou turno.
- Compra do descarte aumentou a mao do jogador para 10.
- Bater valido encerrou a partida com `reason: "knock"`.
- Logs observados: `ONLINE_MATCH_CREATED`, `MATCH_STARTED`, `PLAYER_DRAW_FROM_DECK`, `PLAYER_DRAW_FROM_DISCARD`, `PLAYER_DISCARDED_CARD`, `TURN_CHANGED`, `PLAYER_KNOCKED`, `MATCH_FINISHED`, `ACTION_REJECTED`, `CLIENT_STATE_SENT`.
- `npm run build` passou.
- `npm test` passou com 25/25 testes.
- Tela online `/?online=1` renderizou separada do modo local.
- Modo local `/` continuou abrindo a mesa com 9 cartas.
- Viewport 360x760: tela online sem overflow e mao local sem cartas cortadas.

## Conclusao

Fase 4.4 aprovada para avancar para a 4.5?

Sim.
