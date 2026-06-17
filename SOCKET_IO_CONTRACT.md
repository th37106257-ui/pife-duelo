# Contrato Futuro Socket.io - Pife Duelo

Este documento define uma proposta inicial de eventos para multiplayer em tempo real.

Objetivo: manter a UI desacoplada da rede. O servidor deve ser a fonte oficial do estado da partida.

## Principios

- O cliente envia intencoes: comprar, descartar, bater.
- O servidor valida regras, turno, tempo e cartas.
- O servidor envia estado atualizado para ambos os jogadores.
- O cliente nunca decide sozinho uma vitoria em partida online.
- Cada acao deve ter `matchId`, `playerId`, `actionId` e `clientTime`.
- `actionId` evita duplicidade em caso de reconexao ou clique repetido.

## Estado Base Da Partida

```js
{
  matchId: "match_123",
  status: "waiting" | "playing" | "finished",
  turnPlayerId: "player_1",
  turnStartedAt: 1710000000000,
  turnEndsAt: 1710000060000,
  players: [
    {
      playerId: "player_1",
      name: "VOCE",
      balance: 1250,
      cardsCount: 9,
      connected: true
    }
  ],
  selfHand: [],
  opponentCardsCount: 9,
  drawCount: 36,
  discardTop: null,
  discardCount: 0,
  lastAction: null,
  result: null
}
```

Observacao: cada cliente recebe apenas a propria mao em `selfHand`.

## Eventos Cliente Para Servidor

### match:join

Usado para entrar ou reconectar em uma partida.

```js
{
  matchId: "match_123",
  playerId: "player_1",
  token: "session_token"
}
```

### match:drawStock

Comprar do monte.

```js
{
  matchId: "match_123",
  playerId: "player_1",
  actionId: "act_001",
  clientTime: 1710000001000
}
```

Validacoes do servidor:

- partida em andamento
- jogador conectado
- jogador esta na vez
- jogador ainda nao comprou no turno
- mao tem 9 cartas
- monte tem cartas ou descarte pode reciclar

### match:drawDiscard

Comprar a carta visivel do descarte.

```js
{
  matchId: "match_123",
  playerId: "player_1",
  actionId: "act_002",
  cardId: "7-hearts",
  clientTime: 1710000002000
}
```

Validacoes do servidor:

- jogador esta na vez
- jogador ainda nao comprou no turno
- carta existe no topo do descarte
- carta nao foi descartada pelo mesmo jogador no turno atual
- mao tem 9 cartas

### match:discard

Descartar carta da mao.

```js
{
  matchId: "match_123",
  playerId: "player_1",
  actionId: "act_003",
  cardId: "K-spades",
  clientTime: 1710000003000
}
```

Validacoes do servidor:

- jogador esta na vez
- jogador comprou antes de descartar
- carta pertence a mao do jogador
- mao tem 10 cartas antes do descarte
- mao fica com 9 cartas apos o descarte
- turno alterna apos descarte valido

### match:knock

Acao BATER.

```js
{
  matchId: "match_123",
  playerId: "player_1",
  actionId: "act_004",
  clientTime: 1710000004000
}
```

Validacoes do servidor:

- jogador esta na vez
- partida em andamento
- mao possui 3 combinacoes validas
- pode usar cartas elegiveis do descarte do adversario, conforme regra ativa
- se valido, partida termina
- se invalido, servidor responde erro e partida continua

### match:turnTimeout

Pode ser emitido pelo cliente como indicacao, mas o servidor deve calcular o timeout oficialmente.

```js
{
  matchId: "match_123",
  playerId: "player_1",
  actionId: "act_005",
  clientTime: 1710000060000
}
```

## Eventos Servidor Para Cliente

### match:state

Estado completo permitido para o jogador.

```js
{
  type: "match:state",
  state: {}
}
```

### match:actionApplied

Confirma uma acao aceita.

```js
{
  type: "match:actionApplied",
  actionId: "act_003",
  action: "discard",
  state: {}
}
```

### match:actionRejected

Recusa uma acao invalida.

```js
{
  type: "match:actionRejected",
  actionId: "act_004",
  reason: "INVALID_HAND",
  message: "Mao ainda nao pode bater."
}
```

### match:turnChanged

Informa troca de turno.

```js
{
  type: "match:turnChanged",
  turnPlayerId: "player_2",
  turnStartedAt: 1710000005000,
  turnEndsAt: 1710000065000,
  state: {}
}
```

### match:deckRecycled

Informa reciclagem do descarte para o monte.

```js
{
  type: "match:deckRecycled",
  drawCount: 12,
  discardTop: {
    id: "7-hearts",
    rank: "7",
    suit: "hearts"
  },
  discardCount: 1,
  state: {}
}
```

### match:finished

Resultado final.

```js
{
  type: "match:finished",
  winnerPlayerId: "player_1",
  reason: "knock" | "timeout" | "disconnect",
  groups: [],
  message: "Jogador bateu com 3 combinacoes validas."
}
```

## Codigos De Erro Recomendados

- `NOT_YOUR_TURN`
- `ALREADY_DREW`
- `MUST_DRAW_BEFORE_DISCARD`
- `CARD_NOT_IN_HAND`
- `INVALID_DISCARD_TOP`
- `INVALID_HAND`
- `MATCH_FINISHED`
- `PLAYER_DISCONNECTED`
- `ACTION_DUPLICATED`
- `STATE_OUT_OF_SYNC`

## Fluxo Oficial

1. Servidor cria partida e embaralha baralho.
2. Servidor distribui 9 cartas para cada jogador.
3. Servidor envia `match:state`.
4. Jogador da vez compra do monte ou descarte.
5. Servidor valida e envia `match:actionApplied`.
6. Jogador descarta.
7. Servidor valida descarte, alterna turno e envia `match:turnChanged`.
8. Jogador pode bater quando a mao for valida.
9. Servidor valida BATER e envia `match:finished`.
10. Se o monte acabar, servidor recicla descarte e envia `match:deckRecycled`.

## Preparacao Do Codigo Atual

A camada `src/game/matchEngine.js` ja concentra funcoes puras para:

- criar estado inicial
- comprar do monte
- comprar do descarte
- descartar carta
- validar BATER
- jogar turno do bot
- reciclar descarte

Essa camada deve ser a base para o servidor multiplayer.
