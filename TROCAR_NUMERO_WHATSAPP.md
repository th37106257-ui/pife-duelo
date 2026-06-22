# Trocar o número do WhatsApp do Pife Duelo

## Regra principal

O número conectado atualmente deve ser tratado como uma sessão temporária de teste. Ele não é a identidade oficial definitiva do Pife Duelo.

- Nunca coloque o número do bot no código, frontend ou documentação.
- O número do bot vem da sessão conectada na Evolution API.
- `ADMIN_WHATSAPP_NUMBERS` é uma configuração separada e serve apenas para autorizar administradores.
- Não use o número do bot como administrador por padrão.
- Não ative Pix ou beta real enquanto um número pessoal estiver conectado.

## Antes da troca

- [ ] Confirme que `WHATSAPP_PAYMENTS_ENABLED=false`.
- [ ] Confirme que `PAYMENT_GATE_ENABLED=false`.
- [ ] Confirme que não há pagamentos ou testes financeiros em andamento.
- [ ] Tenha o WhatsApp Business oficial do projeto disponível no novo aparelho ou chip.

## Procedimento de troca

1. Acesse o serviço da Evolution API no Railway.
2. Desconecte a sessão atual da instância `pife-duelo`.
3. Limpe a sessão antiga somente se a Evolution não permitir gerar um novo QR Code ou se a sessão continuar presa.
4. Mantenha o nome da instância como `pife-duelo`.
5. Gere um novo QR Code para essa instância.
6. No celular oficial do projeto, abra WhatsApp Business > Aparelhos conectados > Conectar aparelho.
7. Escaneie o QR Code gerado pela Evolution API.
8. Confirme que a instância mudou para o status `open` e não está `connecting`.
9. Confirme que o webhook continua ativo para o evento `MESSAGES_UPSERT` e aponta para:

   `BACKEND_URL/api/webhooks/evolution`

10. Envie `oi` para o novo número.
11. Confirme a resposta exata:

    `🎴 Pife Duelo online.`

12. Confira nos logs do backend os eventos de mensagem recebida, resposta enviada e webhook processado.

## Depois da validação

- [ ] Revise `ADMIN_WHATSAPP_NUMBERS` separadamente e use somente números de administradores autorizados.
- [ ] Não use o número conectado como bot para conceder permissão administrativa automaticamente.
- [ ] Mantenha tokens, chaves e números somente nas variáveis privadas do Railway.
- [ ] Só configure o menu de mesas depois que o teste simples de `oi` estiver validado.
- [ ] Só ative `WHATSAPP_PAYMENTS_ENABLED` e `PAYMENT_GATE_ENABLED` após revisão financeira completa.
- [ ] Só inicie beta com jogadores reais usando o número oficial exclusivo do projeto.

## Se a nova sessão não conectar

1. Confirme que a Evolution API e o PostgreSQL estão online.
2. Confirme que o volume `/evolution/instances` está montado.
3. Gere outro QR Code e escaneie antes de ele expirar.
4. Se continuar em `connecting`, desconecte a sessão e tente novamente.
5. Apague a instância somente como último recurso e recrie-a com o mesmo nome.

Nunca ative Pix para tentar corrigir um problema de conexão.
