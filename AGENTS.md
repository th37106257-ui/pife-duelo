# AGENTS.md — Pife Duelo

## Objetivo operacional
Trabalhe de forma autônoma no repositório. O usuário não deve precisar abrir PowerShell, copiar comandos, editar arquivos manualmente ou concluir etapas rotineiras fora do Codex quando as ferramentas conectadas permitirem fazer isso diretamente.

## Regras de execução
1. Antes de alterar código, leia o estado atual do repositório, os arquivos relacionados e os logs relevantes do Railway.
2. Prefira mudanças pequenas, reversíveis e acompanhadas por testes.
3. Nunca habilite dinheiro real, saques automáticos ou flags de produção financeira sem autorização explícita do usuário.
4. Nunca exponha segredos, tokens, chaves de API, DATABASE_URL ou dados financeiros sensíveis.
5. Para tarefas financeiras, diferencie claramente:
   - Créditos de Teste: fictícios, sem valor financeiro.
   - Carteira financeira: saldo real/sandbox persistido no PostgreSQL.
6. Se a carteira financeira estiver desligada e os Créditos de Teste estiverem ativos, os comandos de saldo/carteira devem continuar úteis no beta e mostrar somente os créditos fictícios.
7. Sempre execute ou valide os testes diretamente pelas ferramentas disponíveis. Não transfira a obrigação para o usuário.
8. Se uma tarefa for interrompida, retome pelo estado do Git/GitHub e pelos logs do Railway. Não peça ao usuário para repetir passos já concluídos.
9. Ao terminar uma etapa, deixe um commit/branch/PR identificável e registre o que foi validado e o próximo passo.
10. Evite pedir confirmações intermediárias para ações seguras e reversíveis. Peça confirmação apenas para ações destrutivas, deploys irreversíveis ou ativação de dinheiro real.

## Critério de conclusão
Uma tarefa só está concluída quando:
- a causa foi identificada;
- a correção foi implementada;
- existe cobertura de teste adequada;
- não houve regressão óbvia nos fluxos relacionados;
- o estado do deploy foi verificado quando aplicável;
- o próximo passo está claro.

## Testes principais
Use os scripts do package.json, priorizando:
- npm test
- npm run test:financial-whatsapp
- npm run test:demo-credits
- npm run test:financial-wallet

Não dependa de PowerShell do usuário para executar esses testes.

## Continuidade
Quando retomar uma sessão:
1. inspecione branch/PR aberto;
2. compare com main;
3. cheque últimos deployments do Railway;
4. cheque logs recentes;
5. continue do último teste pendente.
