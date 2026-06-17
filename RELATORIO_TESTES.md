# Relatorio de Testes - Pife Duelo

Gerado em: 28/05/2026, 00:43:16

Resumo: 21 passando, 0 falhando.

| Status | Teste | Detalhe |
| --- | --- | --- |
| PASS | createDeck cria 52 cartas + 2 coringas validos | ok |
| PASS | distribuicao inicial preserva baralho sem duplicar | ok |
| PASS | recycleDiscardPile recicla descarte mantendo topo visivel | ok |
| PASS | validacao de trincas aceita valor igual com naipes diferentes | ok |
| PASS | validacao de sequencias exige mesmo naipe em ordem | ok |
| PASS | validacao de mao vencedora e mao invalida | ok |
| PASS | comandos debug iniciam maos controladas | ok |
| PASS | debug de vitoria rapida e derrota rapida sao consistentes | ok |
| PASS | compra do monte exige turno correto e preserva cartas | ok |
| PASS | compra dupla e acao fora do turno sao bloqueadas | ok |
| PASS | descarte obrigatorio apos compra alterna turno | ok |
| PASS | descarte sem compra e carta inexistente sao bloqueados | ok |
| PASS | compra do descarte aceita carta do bot e bloqueia carta propria | ok |
| PASS | motor detecta carta duplicada e bloqueia estado invalido | ok |
| PASS | bot escolhe descarte util e evita descartar sequencia pronta | ok |
| PASS | turno do bot compra, descarta e preserva cartas | ok |
| PASS | multiplayer local alterna Jogador A e Jogador B sem bot obrigatorio | ok |
| PASS | multiplayer local permite Jogador B pegar descarte do Jogador A | ok |
| PASS | multiplayer local valida bater e timeout por ator | ok |
| PASS | bater invalido nao gera vitoria e bater valido nasce no motor | ok |
| PASS | timeout gera derrota controlada pelo motor | ok |

Comandos debug disponiveis:
- npm run DEBUG_WIN_HAND
- npm run DEBUG_BOT_WIN
- npm run DEBUG_RECYCLE
- npm run DEBUG_TIMEOUT
- npm run DEBUG_INVALID_HAND
- npm run MULTIPLAYER_LOCAL
