# Auditoria Pife Duelo

Data da auditoria: 27/05/2026

## Resumo Executivo

O projeto Pife Duelo V1 foi auditado em build, regras de baralho, fluxo de partida e responsividade mobile.

Resultado geral: aprovado para continuar evoluindo como beta visual e funcional. Nao foram encontrados bugs bloqueadores durante a auditoria.

## O Que Esta Funcionando

- O projeto compila corretamente com `npm run build`.
- O jogo abre em `http://127.0.0.1:5173/` sem erro fatal.
- O baralho possui 54 cartas: 52 cartas padrao mais 2 coringas.
- Todos os naipes oficiais estao presentes: espadas, copas, ouros e paus.
- Todos os valores oficiais estao presentes: A, 2, 3, 4, 5, 6, 7, 8, 9, 10, J, Q e K.
- A distribuicao inicial entrega 9 cartas para o jogador e 9 cartas para o oponente.
- O monte inicia com 36 cartas apos a distribuicao.
- A compra do monte funciona.
- A mao do jogador passa para 10 cartas apos comprar.
- O descarte funciona apos compra.
- A mao do jogador volta para 9 cartas apos descarte e rodada do bot.
- O turno alterna corretamente entre jogador e bot.
- O modo manual permite reorganizar cartas mantendo a ordem escolhida pelo jogador.
- O modo automatico organiza cartas por combinacoes quando ativado.
- O bot compra, avalia a mao e descarta automaticamente.
- O bot pode bater quando encontra combinacao valida.
- O timer de 60 segundos roda e derrota o jogador quando chega a zero.
- A reciclagem do descarte para o monte funciona quando o monte acaba.
- A ultima carta visivel do descarte permanece no descarte durante a reciclagem.
- As cartas recicladas voltam ao monte sem metadados indevidos de descarte.
- O botao BATER fica bloqueado em mao invalida.
- A regra valida trincas por mesmo valor e naipes diferentes.
- A regra valida sequencias por mesmo naipe e ordem numerica.
- Sequencias com naipes misturados sao rejeitadas.
- A marca PIFE DUELO aparece no verso das cartas.
- Nao houve erros no console durante o fluxo auditado.

## Auditoria Visual

Foram verificados os tamanhos:

- 360x800
- 390x844
- 414x896
- 430x932

Resultado:

- Sem overflow horizontal.
- Cartas do jogador dentro da tela.
- Cartas do oponente dentro da tela.
- HUD do jogador e do oponente dentro da tela.
- Timer dentro da tela e sem invadir a mao do oponente.
- Botao BATER dentro da tela e sem cobrir cartas.
- Monte e descarte dentro da area central.
- Mesa, HUD, timer e botao BATER seguem a identidade verde premium.
- Feltro, vinheta, brilho central e textura estao aplicados.

## O Que Foi Corrigido/Confirmado

- Confirmado que as cartas nao saem da tela nos tamanhos mobile auditados.
- Confirmado que nao existe overflow horizontal nos tamanhos mobile auditados.
- Confirmado que a HUD nao exibe quantidade de cartas.
- Confirmado que o botao BATER nao cobre a mao do jogador.
- Confirmado que o timer nao fica escondido atras da mao do oponente.
- Confirmado que a identidade visual verde premium esta aplicada em HUD, timer e botao BATER.
- Confirmado que o visual das costas das cartas contem PIFE DUELO.
- Confirmado que compra e descarte nao duplicam cartas no fluxo normal auditado.
- Confirmado que o descarte por carta selecionada funciona como apoio ao gesto de arrastar no mobile.
- Confirmado que o jogo continua apos reciclar o descarte para o monte.

## Bugs Encontrados

Nenhum bug bloqueador foi encontrado.

Observacoes de risco:

- O bot pode bater rapidamente se receber uma mao valida, o que e correto pela regra atual, mas pode parecer abrupto para o jogador em uma demonstracao.
- Ainda nao existe uma suite automatizada completa de testes de interface. A validacao foi feita por scripts locais e auditoria no navegador.
- O teste visual de botao BATER ativo foi validado pela regra local e pelo estado desabilitado em mao invalida, mas ainda seria ideal criar um modo de teste com mao predefinida para verificar o estado ativo diretamente na interface.
- O gesto de arrastar depende do comportamento do navegador/dispositivo. Foi mantido o suporte adicional de selecionar carta e tocar no descarte para melhorar a experiencia em Android.

## O Que Ainda Precisa Melhorar

- Criar um modo interno de debug/teste com mao predefinida para validar visualmente vitoria, derrota, BATER ativo e reciclagem sem depender do embaralhamento aleatorio.
- Adicionar testes automatizados com Playwright ou Vitest para regras e fluxo visual.
- Melhorar feedback visual quando o bot bate, para a derrota parecer mais explicada.
- Adicionar historico curto de acoes da rodada, de forma discreta, sem poluir a mesa.
- Refinar a animacao de arrastar no Android em dispositivo real.
- Adicionar sons e vibracao tatil no futuro, com opcao de desligar.
- Preparar camada de sincronizacao para multiplayer com Socket.io sem acoplar a UI a rede.

## Proximos Passos Recomendados

1. Criar testes automatizados para `createDeck`, `validateDeck`, `recycleDiscardPile`, trincas, sequencias e mao vencedora.
2. Criar um modo `audit` ou `debug` para iniciar partidas com maos controladas.
3. Testar em aparelho Android real com toque e arraste.
4. Criar animacao dedicada para vitoria do jogador e vitoria do bot.
5. Separar regras de partida em uma camada ainda mais independente para facilitar multiplayer.
6. Documentar o contrato futuro do Socket.io: compra, descarte, bater, turno, timeout e reciclagem.

## Resultado Final

O Pife Duelo V1 esta consistente como beta mobile-first: visual premium aplicado, cartas dentro da tela, regras principais funcionando, baralho validado, fluxo basico jogavel e sem erros de console na auditoria.
