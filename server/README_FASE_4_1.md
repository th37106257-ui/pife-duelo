# Fase 4.1 - Servidor Node.js

## Objetivo

Criar a base do servidor multiplayer do Pife Duelo.

## Como rodar

```bash
cd server
npm install
npm run dev
```

Para rodar sem nodemon:

```bash
npm start
```

## Rotas de teste

- `GET /health`
- `GET /api/status`
- `GET /api/rooms`
- `POST /api/rooms`
- `GET /api/rooms/:roomId`
- `GET /api/matches`
- `POST /api/matches`
- `GET /api/matches/:matchId`

## Exemplos rapidos

Criar sala:

```bash
curl -X POST http://localhost:3001/api/rooms ^
  -H "Content-Type: application/json" ^
  -d "{\"players\":[{\"name\":\"Jogador 1\"},{\"name\":\"Jogador 2\"}]}"
```

Criar partida:

```bash
curl -X POST http://localhost:3001/api/matches ^
  -H "Content-Type: application/json" ^
  -d "{\"roomId\":\"ROOM_ID_AQUI\"}"
```

## Observacao

Esta fase nao ativa o multiplayer online ainda.
Socket.io entra na Fase 4.2.

Nao conectar este servidor ao frontend nesta fase.
