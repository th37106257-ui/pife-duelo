# Pife Duelo V1

Protótipo mobile-first de Pife em React, Tailwind CSS e Framer Motion.

## Recursos

- Mesa vertical para celular com feltro verde escuro e borda de madeira.
- Baralho padrão de 52 cartas + 2 coringas.
- 9 cartas para o jogador e 9 para o bot.
- Compra do monte, descarte de carta selecionada e botão Bater.
- Validação inicial de trincas e sequências simples.
- Bot offline com jogada automática.
- Timer circular de 60 segundos com derrota automática.
- Animações de compra, descarte, seleção e fim de partida.
- Estrutura preparada para futura integração com Socket.io.

## Como rodar

```bash
npm install
npm run dev
```

Depois abra o endereço local mostrado pelo Vite no navegador.

No PowerShell do Windows, se `npm` for bloqueado pela politica de scripts, use:

```powershell
npm.cmd install
npm.cmd run dev
```

## Testes automatizados

```bash
npm test
npm run test:report
```

Os testes cobrem baralho, validacao de cartas, reciclagem do descarte, trincas, sequencias, mao vencedora, compra, descarte, alternancia de turno, bloqueios do motor e debug. O comando `test:report` gera `RELATORIO_TESTES.md`.

## Modo audit/debug

Use estes comandos para iniciar partidas controladas:

```bash
npm run DEBUG_WIN_HAND
npm run DEBUG_BOT_WIN
npm run DEBUG_RECYCLE
npm run DEBUG_TIMEOUT
npm run DEBUG_INVALID_HAND
npm run MULTIPLAYER_LOCAL
```

Tambem e possivel abrir direto pela URL:

```txt
http://127.0.0.1:5173/?debug=DEBUG_WIN_HAND
http://127.0.0.1:5173/?debug=DEBUG_BOT_WIN
http://127.0.0.1:5173/?debug=DEBUG_RECYCLE
http://127.0.0.1:5173/?debug=DEBUG_TIMEOUT
http://127.0.0.1:5173/?debug=DEBUG_INVALID_HAND
http://127.0.0.1:5173/?mode=local-2p
```

No modo `MULTIPLAYER_LOCAL`, Jogador A e Jogador B se alternam no mesmo aparelho, sem Socket.io e sem bot automatico.

Documentos uteis:

- `SOCKET_IO_CONTRACT.md`
- `ANDROID_REAL_DEVICE_TEST.md`
- `AUDITORIA_PIFE_DUELO.md`
