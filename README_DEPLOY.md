# Deploy Railway - Pife Duelo

Este projeto esta em formato monorepo simples:

- Frontend React/Vite na raiz do repositorio.
- Backend Express + Socket.io na pasta `server/`.

## Modo recomendado atual: um servico unico no Railway

O projeto tambem esta preparado para rodar **frontend + backend no mesmo servico Railway**.
Esse e o modo mais simples para a versao atual:

- o build gera o frontend em `dist/`;
- o start sobe o servidor Node/Socket.io;
- o mesmo servidor entrega o React, `/health`, `/api` e `/socket.io`.

Configuracao do servico unico:

- Root Directory: `/`
- Build Command: `npm install && npm run build`
- Start Command: `npm start`

Variaveis de ambiente:

```env
NODE_ENV=production
CLIENT_URL=https://URL-DO-SERVICO-RAILWAY
ALLOWED_CLIENT_URLS=https://URL-DO-SERVICO-RAILWAY
ADMIN_PASSWORD=crie_uma_senha_forte
DISCONNECT_GRACE_SECONDS=60
```

Observacoes:

- Nao cadastre `PORT` manualmente. O Railway injeta `PORT` automaticamente.
- `VITE_SOCKET_URL` pode ficar vazio neste modo, porque o socket usa o mesmo dominio do frontend.
- Depois do deploy, `/health` deve retornar JSON e `/socket.io/?EIO=4&transport=polling` deve retornar uma resposta tecnica do Socket.io, nao HTML.

## Modo alternativo: dois servicos separados

Se quiser separar infraestrutura depois, use **dois servicos separados no mesmo projeto Railway**:

1. `pife-duelo-server`
2. `pife-duelo-web`

Isso separa o build do Vite do processo do Socket.io e deixa `VITE_SOCKET_URL` configuravel.

## 1. Subir no GitHub

Confirme que o repositorio esta no GitHub e que arquivos sensiveis nao foram enviados:

- nao subir `.env`;
- nao subir `node_modules`;
- nao subir `dist`;
- nao subir logs locais.

O arquivo seguro para referencia e `.env.example`.

## 2. Criar projeto no Railway

1. Acesse Railway.
2. Clique em `New Project`.
3. Clique em `Deploy from GitHub Repo`.
4. Selecione o repositorio do Pife Duelo.
5. Crie primeiro o servico do backend.

## 3. Servico backend: pife-duelo-server

Configuracao do servico:

- Root Directory: `server`
- Build Command: `npm install`
- Start Command: `npm start`

Variaveis de ambiente do backend:

```env
NODE_ENV=production
CLIENT_URL=https://URL-DO-FRONTEND-RAILWAY
ALLOWED_CLIENT_URLS=https://URL-DO-FRONTEND-RAILWAY
ADMIN_PASSWORD=crie_uma_senha_forte
DISCONNECT_GRACE_SECONDS=60
```

Observacoes:

- Nao cadastre `PORT` manualmente. O Railway injeta `PORT` automaticamente e o servidor usa `process.env.PORT || 3000`.
- Nao deixe `ADMIN_PASSWORD` vazio em producao.
- Nao use `*` no CORS em producao.

Depois do deploy, gere o dominio publico do backend em:

`Settings -> Networking -> Generate Domain`

Teste:

```txt
https://URL-DO-SERVIDOR-RAILWAY/health
```

Resposta esperada:

```json
{
  "status": "ok",
  "uptime": 123,
  "activeMatches": 0,
  "onlinePlayers": 0
}
```

## 4. Servico frontend: pife-duelo-web

No mesmo projeto Railway, adicione outro servico a partir do mesmo GitHub repo.

Configuracao do servico:

- Root Directory: `/`
- Build Command: `npm install && npm run build`
- Start Command: `npm start`

Variaveis de ambiente do frontend:

```env
NODE_ENV=production
VITE_SOCKET_URL=https://URL-DO-SERVIDOR-RAILWAY
```

Depois do deploy, gere o dominio publico do frontend em:

`Settings -> Networking -> Generate Domain`

Volte no backend e atualize:

```env
CLIENT_URL=https://URL-DO-FRONTEND-RAILWAY
ALLOWED_CLIENT_URLS=https://URL-DO-FRONTEND-RAILWAY
```

Redeploy o backend apos trocar essas variaveis.

## 5. Como voltar para modo local

Na raiz:

```bash
npm install
npm run dev
```

No backend:

```bash
cd server
npm install
npm start
```

Crie um `.env` local baseado em `.env.example`:

```env
NODE_ENV=development
PORT=3000
CLIENT_URL=http://localhost:5173
ALLOWED_CLIENT_URLS=http://localhost:5173
VITE_SOCKET_URL=http://localhost:3000
ADMIN_PASSWORD=trocar_essa_senha
DISCONNECT_GRACE_SECONDS=60
```

## 6. Testes obrigatorios no Railway

1. Abrir `/health` no backend.
2. Abrir o frontend publico.
3. Abrir o modo online do jogo.
4. Confirmar conexao Socket.io sem erro no console.
5. Entrar na fila com jogador A.
6. Entrar na fila com jogador B em outra aba/celular.
7. Confirmar `matchFound`.
8. Iniciar partida.
9. Comprar do monte.
10. Comprar do descarte.
11. Descartar carta.
12. Bater com mao valida.
13. Recarregar a pagina e testar reconexao por `playerId/matchId`.
14. Abrir admin e autenticar com `ADMIN_PASSWORD`.
15. Ver dashboard, historico e auditoria.

## 7. Comandos finais por servico

Backend Railway:

```bash
npm install
npm start
```

Frontend Railway:

```bash
npm install
npm run build
npm start
```

## 8. Checklist de erro comum

- Se o frontend nao conecta no socket: verificar `VITE_SOCKET_URL`.
- Se o socket falha por CORS: verificar `CLIENT_URL` e `ALLOWED_CLIENT_URLS` no backend.
- Se admin nao abre: verificar `ADMIN_PASSWORD`.
- Se `/health` nao responde: verificar logs do backend e se `PORT` esta sendo usado.
- Se o frontend abre mas rotas internas quebram: confirmar que `npm start` esta servindo `dist/index.html`.
