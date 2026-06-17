# Fase 4.3 - Salas Online e Matchmaking

## Objetivo

Criar fila de espera, matchmaking 1x1 e salas automaticas para o Pife Duelo.

## Eventos

Cliente para servidor:

- `joinQueue`
- `leaveQueue`
- `requestQueueStatus`

Servidor para cliente:

- `queueJoined`
- `queueLeft`
- `queueTimeout`
- `queueStatus`
- `matchFound`
- `matchmakingError`

## Filas por mesa

Mesas aceitas:

- `2`
- `5`
- `10`
- `20`

Jogadores so sao pareados quando entram na mesma mesa.

## Como testar

1. Rodar o servidor.
2. Rodar o frontend.
3. Abrir dois navegadores em `http://localhost:5173/?online=1`.
4. No navegador A, entrar na mesa R$2.
5. Confirmar a tela "Procurando adversario...".
6. No navegador B, entrar na mesa R$2.
7. Confirmar que ambos recebem `matchFound` e o mesmo `roomId`.

## Testes manuais

- Entrar em R$2 e R$5 com navegadores diferentes para confirmar que nao pareiam.
- Clicar em Cancelar para confirmar `queueLeft`.
- Esperar o limite de fila para confirmar `queueTimeout`.
- Clicar em Jogar varias vezes para confirmar que a fila nao duplica.

## Observacao

Esta fase ainda nao sincroniza cartas nem acoes da partida.
Compra online, descarte online, turnos online, estado autoritativo, reconexao e pagamento ficam para fases futuras.
