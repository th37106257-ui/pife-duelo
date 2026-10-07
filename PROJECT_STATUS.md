# Pife Duelo — Status Canônico do Projeto

Atualizado em: 2026-10-07

Este arquivo é a fonte única de verdade operacional do projeto. Antes de sugerir, implementar ou reabrir qualquer etapa, compare a tarefa com este status. Em caso de conflito com README antigo, conversa antiga, comentário ou plano anterior, este arquivo e o código atual em `main` têm prioridade.

## Estado atual em produção
- Serviço principal Railway: online e saudável.
- Deploy de produção atual inclui o onboarding de primeira entrada no WhatsApp.
- WhatsApp/Evolution: ativo em produção.
- Créditos de Teste: persistência PostgreSQL ativa.
- Dinheiro real, Pix real e saques: não habilitar sem autorização explícita.

## Concluído e validado

### Jogo 1x1
- 9 cartas.
- Sem coringa.
- Combinações válidas: trincas e sequências.
- Bater encerra a partida quando a mão é válida.
- Timer de 60 segundos.
- Compra, descarte, alternância de turno e validações server-authoritative.
- Reconexão e preservação de partida.
- Links individuais de acesso.
- Partidas iniciadas protegidas contra cancelamento indevido.
- Fluxo online já testado com partida concluída com sucesso.

### WhatsApp
- Menu principal atual:
  - Jogar agora
  - Carteira
  - Regras
  - Suporte
- Indicador de atividade real:
  - fila vazia: Arena aberta
  - 1 jogador: 1 jogador aguardando adversário
  - 2+: contagem real
- Navegação por estado.
- Regras, suporte, atualizações, status, link e treino.
- Retorno pós-partida ao WhatsApp disponível.
- Onboarding de primeira entrada disponível em produção:
  - aparece apenas na criação inicial da conta de Créditos de Teste;
  - apresenta o jogo;
  - oferece jogar a primeira partida ou ver explicação rápida;
  - destaca a mesa de 2 Créditos de Teste como recomendada;
  - depois disso, o menu normal permanece inalterado.

### Créditos de Teste
- Saldo inicial padrão atual: 100 Créditos de Teste.
- Créditos são fictícios, sem valor financeiro.
- PostgreSQL em produção.
- Ledger persistente.
- Idempotência.
- Reserva antes da fila.
- Uma reserva ativa por jogador.
- Reserva liberada quando a entrada pré-partida é cancelada.
- Consumo atômico dos dois participantes no MATCH_STARTED.
- MATCH_STARTED duplicado não consome duas vezes.
- Recompensa do vencedor idempotente.
- Compensação por aborto técnico.
- Persistência após reinício.
- Falha de banco fecha com segurança.
- Corrida cancelamento x início validada.
- E2E validado: WhatsApp -> fila -> acesso -> partida -> reconexão -> encerramento.
- Testes PostgreSQL de concorrência já existem no CI.

### Financeiro real / Asaas
- Arquitetura de carteira financeira existe separada dos Créditos de Teste.
- Ledger financeiro, webhook, depósito, reserva/commit/settlement e fluxos administrativos já foram desenvolvidos/testados em sandbox.
- Retorno automático às mesas após confirmação de Pix foi implementado.
- Produção financeira real permanece desligada.
- Não reativar dinheiro real, saques, Pix real ou Asaas de produção sem autorização explícita e sem resolver requisito operacional/jurídico do provedor.

### Segurança e continuidade
- Safe Entry.
- Proteção de links/tokens.
- Multi-aba/acesso antigo tratado.
- Logs e observabilidade.
- CI com PostgreSQL 16.
- Testes principais no CI:
  - Safe Entry PostgreSQL
  - Demo Credits PostgreSQL
  - propagação assíncrona
  - Financial E2E
  - demo credits
  - entries
  - financial wallet
  - financial WhatsApp
  - suíte completa
  - online sync
  - build
  - diff check

## PRs já concluídos
- PR #1 — saldo do beta/carteira e continuidade do Codex.
- PR #2 — retorno automático às mesas após Pix confirmado.
- PR #3 — Créditos de Teste atômicos em PostgreSQL e testes de concorrência.
- PR #4 — menu inicial novo e atividade real da fila.
- PR #5 — onboarding de primeira entrada no WhatsApp.

## Não tratar como pendência novamente
Os itens abaixo já foram feitos e só devem ser reabertos se houver evidência de regressão, bug novo ou pedido explícito:
- atomicidade da reserva;
- consumo no MATCH_STARTED;
- proteção contra consumo duplo;
- recompensa idempotente;
- compensação de aborto técnico;
- cancelamento x início;
- persistência PostgreSQL dos Créditos de Teste;
- E2E de reconexão e settlement;
- menu novo do WhatsApp;
- contador real da fila;
- onboarding de iniciante;
- retorno pós-Pix para mesas;
- saldo de Créditos de Teste no menu Carteira durante beta.

## Pendências reais / próximas frentes
Priorize somente itens que ainda não constam como concluídos acima. Hoje as frentes mais prováveis são:
1. hardening do frontend/navegador e revisão de exposição pública;
2. teste de carga/concorrência em escala maior, além dos testes funcionais já existentes;
3. melhorias de auditoria/admin e relatórios operacionais;
4. acompanhamento de estabilidade do beta com usuários reais;
5. revisão controlada de dependências/vulnerabilidades sem `npm audit fix --force`;
6. futuras decisões de produto: ranking, histórico do jogador, modo 4 jogadores, Arena/Bomberman;
7. financeiro real apenas quando autorizado e operacionalmente viável.

## Regra de retomada
Antes de responder “o próximo passo é...”:
1. ler este arquivo;
2. conferir PRs/commits recentes;
3. conferir deploy atual do Railway quando a tarefa for de produção;
4. verificar se a suposta pendência já está em “Concluído e validado”;
5. só então propor a próxima etapa.

## Observação sobre documentação antiga
`README.md` contém trechos históricos que não representam integralmente o produto atual, como referências antigas a coringas e protótipo offline. Não usar o README antigo como fonte de verdade de regras/estado sem confrontar este arquivo e o código atual.
