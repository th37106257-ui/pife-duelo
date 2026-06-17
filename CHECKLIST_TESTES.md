# CHECKLIST_TESTES - Pife Duelo V1

Use este checklist no navegador com o projeto aberto em `http://127.0.0.1:5173/`.

## 1. Distribuicao inicial

- Ao abrir ou reiniciar a partida, confira se o jogador comeca com 9 cartas na mao.
- Confira se o oponente aparece com 9 cartas viradas para baixo.
- O monte deve iniciar com 36 cartas, considerando baralho de 52 cartas + 2 coringas.
- O descarte deve iniciar vazio.

## 2. Turno alternado

- No inicio, a vez deve ser do jogador.
- Compre uma carta e descarte uma carta arrastando para o descarte.
- Depois do descarte, o turno deve passar para o oponente.
- Aguarde a jogada automatica do oponente.
- Quando o oponente descartar, o turno deve voltar para o jogador.

## 3. Compra do monte

- Na vez do jogador, toque no monte de compra.
- A mao deve passar de 9 para 10 cartas.
- A carta comprada deve entrar na mao com animacao.
- Tentar comprar novamente no mesmo turno nao deve adicionar outra carta.

## 4. Compra do descarte

- Aguarde o oponente descartar uma carta.
- Na sua vez, toque na pilha de descarte.
- A carta do topo deve sair do descarte e entrar na mao do jogador.
- A mao deve passar de 9 para 10 cartas.
- Nao deve ser possivel pegar uma carta descartada pelo proprio jogador.

## 5. Descarte obrigatorio apos compra

- Depois de comprar do monte ou do descarte, tente encerrar a jogada sem descartar.
- O turno nao deve passar automaticamente.
- Arraste uma carta da mao para a pilha de descarte.
- A mao deve voltar para 9 cartas.
- Apenas depois do descarte o turno deve ir para o oponente.

## 6. Reconhecimento de trincas

- Monte uma mao com 3 cartas do mesmo valor e naipes diferentes, por exemplo 5 de Copas, 5 de Ouros e 5 de Espadas.
- A validacao deve reconhecer essa trinca como combinacao.
- Uma combinacao com valores diferentes nao deve contar como trinca.

## 7. Reconhecimento de sequencias

- Monte uma mao com 3 cartas em ordem do mesmo naipe, por exemplo 7, 8 e 9 de Paus.
- A validacao deve reconhecer essa sequencia.
- Cartas em ordem, mas com naipes misturados, nao devem contar como sequencia.

## 8. Botao BATER ativo apenas com mao vencedora

- Com uma mao sem 3 combinacoes validas, confira se o botao BATER aparece apagado e desabilitado.
- Forme 3 combinacoes validas usando apenas a mao ou usando cartas descartadas pelo oponente.
- O botao BATER deve ficar ativo, com pulso/brilho discreto.
- Clique em BATER.
- A partida deve mostrar vitoria do jogador.

## 9. Bloqueio do BATER com mao invalida

- Em uma mao invalida, tente clicar no botao BATER.
- O botao deve estar desabilitado e nao deve abrir modal de vitoria.
- A partida deve continuar normalmente.

## 10. Vitoria ao bater

- Com 3 combinacoes validas, clique no botao BATER.
- Deve aparecer modal de vitoria.
- A mesa nao deve continuar aceitando compra, descarte ou novas jogadas enquanto o modal estiver ativo.

## 11. Derrota por timeout

- Inicie uma partida e nao jogue durante 60 segundos na vez do jogador.
- Quando o tempo chegar a zero, deve aparecer modal de derrota.
- A derrota deve acontecer automaticamente, sem exigir clique.

## 12. Layout mobile sem overflow

- Teste a tela em larguras aproximadas de 360px, 390px e 430px.
- Nenhum elemento deve sair da moldura da mesa.
- A pagina nao deve criar rolagem horizontal.
- As areas do oponente, centro e jogador devem continuar separadas.

## 13. Cartas sempre dentro da tela

- Teste com 9 cartas na mao do jogador.
- Compre uma carta e confira a mao com 10 cartas.
- Todas as cartas devem permanecer 100% dentro da tela.
- Repita o fluxo comprando do descarte.
- Nenhuma carta deve ficar cortada nas laterais ou embaixo.

## 14. HUD sem quantidade de cartas

- Confira a HUD do jogador.
- Confira a HUD do oponente.
- As HUDs devem mostrar apenas avatar, nome, saldo e indicador de turno.
- A quantidade de cartas nao deve aparecer na HUD.

## 15. Botao BATER sem cobrir cartas

- Verifique o canto inferior direito da mesa.
- O botao BATER deve ficar acima da area da mesa, sem cobrir cartas da mao.
- Ao comprar a decima carta, o botao ainda nao deve cobrir a mao.
- Em telas menores, o botao deve continuar dentro da tela.

## 16. Animacoes sem quebrar a logica

- Compre carta do monte e confira se apenas uma carta entra na mao.
- Pegue carta do descarte e confira se apenas uma carta entra na mao.
- Arraste uma carta para descarte e confira se apenas uma carta sai da mao.
- Aguarde o oponente jogar e confira se a animacao nao altera a contagem final.
- Durante animacoes, nao deve ser possivel burlar a regra de uma compra + um descarte por turno.

## 17. Reciclagem automatica do descarte

- Continue a partida ate o monte de compra chegar a zero.
- Toque no monte quando houver mais de uma carta no descarte.
- O jogo deve manter a ultima carta visivel no descarte.
- As cartas anteriores do descarte devem voltar embaralhadas para o monte.
- A partida deve continuar normalmente, sem modal de fim e sem travar.
- Confira se nenhuma carta some ou aparece duplicada.

## 18. Validacao completa do baralho

- Ao iniciar ou reiniciar a partida, o jogo deve carregar sem erros.
- O baralho oficial deve ter 52 cartas normais + 2 coringas.
- Os naipes aceitos sao Copas, Ouros, Paus e Espadas.
- Os valores aceitos sao A, 2, 3, 4, 5, 6, 7, 8, 9, 10, J, Q e K.
- Nao deve existir carta normal repetida, carta faltando ou carta com simbolo invalido.

## 19. Identidade nas costas das cartas

- Confira as cartas viradas do oponente.
- Confira o monte de compra.
- As costas devem mostrar "PIFE DUELO" de forma discreta e centralizada.
- O texto deve parecer integrado ao desenho da carta, sem atrapalhar a leitura da mesa.

## 20. HUD verde premium

- Confira a HUD do jogador e do oponente.
- O brilho principal deve estar em verde premium, nao azul/ciano.
- O indicador de turno deve continuar funcionando.
- As animacoes, tamanhos, profundidade e vidro fosco devem permanecer iguais.

## Resultado esperado geral

- Jogador e oponente iniciam com 9 cartas.
- O jogador pode ficar com 10 cartas somente apos comprar.
- Apos descartar, volta para 9 cartas.
- O botao BATER so fica ativo com mao vencedora.
- Se o monte acabar, o descarte recicla automaticamente e a partida continua.
- O jogo termina apenas por BATER valido, bot batendo ou timeout.
- A interface permanece mobile-first, sem overflow e sem cartas cortadas.
