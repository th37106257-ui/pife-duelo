# Pife Duelo - Teste MVP Fase 3

Objetivo: validar o MVP 1x1 contra bot em mobile/Android sem alterar regras, visual aprovado ou fluxo principal.

## Como testar

- Abrir o jogo em largura mobile/Android.
- Jogar partidas completas contra o bot.
- Usar "Nova partida" ou "Jogar novamente" sem recarregar a pagina.
- Observar o console do navegador para os eventos internos.

## Eventos esperados no console

- MATCH_STARTED
- CARD_DRAWN
- CARD_DISCARDED
- TURN_CHANGED
- PLAYER_TIMEOUT
- PLAYER_KNOCKED
- MATCH_FINISHED
- MATCH_RESTARTED
- INVALID_ACTION_BLOCKED

Cada evento deve trazer: matchId, player, currentTurn, handCount e timestamp.

## Checklist funcional

- [ ] Layout mobile sem cortes laterais.
- [ ] HUD discreto e sem bloquear cartas ou botoes.
- [ ] Jogador compra do monte corretamente.
- [ ] Jogador compra do descarte corretamente quando permitido.
- [ ] Carta comprada entra no final da mao sem desalinhamento.
- [ ] Drag da mao fica fluido, sem tremor e sem carta presa.
- [ ] Placeholder aparece no ponto correto.
- [ ] Reorganizacao manual atualiza a ordem real da mao.
- [ ] Descarte por arraste funciona.
- [ ] Descarte por toque/selecionar funciona quando aplicavel.
- [ ] Carta descartada nao duplica.
- [ ] Carta do topo do descarte aparece limpa e por cima.
- [ ] Sequencia lado a lado mostra circulo de combinacao.
- [ ] Trinca lado a lado mostra circulo de combinacao.
- [ ] Combinacao separada nao mostra circulo.
- [ ] Botao Bater fica desativado fora da condicao real.
- [ ] Botao Bater nao funciona durante drag ou animacao.
- [ ] Botao Bater nao aceita clique duplo.
- [ ] Turno passa corretamente para o bot.
- [ ] Bot pensa antes de jogar.
- [ ] Turno volta corretamente para o jogador.
- [ ] Timer nao trava.
- [ ] Timeout encerra a partida corretamente.
- [ ] Tela final mostra Vitoria, Derrota ou Derrota por tempo.
- [ ] Jogar novamente reinicia sem recarregar a pagina.
- [ ] Nova partida reinicia sem recarregar a pagina.
- [ ] Nenhum erro aparece no console.

## Teste de resistencia

Registrar 10 partidas completas seguidas:

| # | Resultado | Reiniciou sem reload | Sem duplicacao | Turno OK | Timer OK | Observacoes |
|---|-----------|----------------------|----------------|----------|----------|-------------|
| 1 |           |                      |                |          |          |             |
| 2 |           |                      |                |          |          |             |
| 3 |           |                      |                |          |          |             |
| 4 |           |                      |                |          |          |             |
| 5 |           |                      |                |          |          |             |
| 6 |           |                      |                |          |          |             |
| 7 |           |                      |                |          |          |             |
| 8 |           |                      |                |          |          |             |
| 9 |           |                      |                |          |          |             |
| 10 |          |                      |                |          |          |             |

## Criterio de aprovacao

- 10 partidas completas consecutivas sem travar turno.
- Reinicio funciona sem reload.
- Sem duplicacao de cartas na mao, overlay ou descarte.
- Botao Bater so ativa com condicao real.
- Timer justo e funcional.
- Android fluido.
- Logs internos presentes.
- Tela de resultado funcional.
