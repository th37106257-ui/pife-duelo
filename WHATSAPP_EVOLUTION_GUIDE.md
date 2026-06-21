# WhatsApp + Evolution API — operação segura

Este recurso recebe comprovantes de Pix, mas nunca aprova um pagamento automaticamente. A aprovação é sempre manual pelo painel admin ou pelo WhatsApp autorizado.

## Antes de ativar

- Use apenas uma réplica do backend no Railway. O MVP usa um arquivo persistente para os pagamentos.
- Crie um Volume no serviço do Pife Duelo e monte-o em `/data`.
- Não coloque chave Pix, token da Evolution, senha ou número pessoal no GitHub.
- Faça primeiro um teste com valor controlado.

## Variáveis do Railway

Configure no backend:

```env
ADMIN_WHATSAPP_NUMBERS=NUMERO_ADMIN_COM_DDI
PAYMENT_STORE_PATH=/data/payments.json
PAYMENT_ACCESS_SECRET=SEGREDO_LONGO_E_ALEATORIO
PAYMENT_EXPIRY_MINUTES=60
PAYMENT_ACCESS_TTL_MINUTES=180
PUBLIC_GAME_URL=FRONTEND_URL
EVOLUTION_API_URL=URL_DA_EVOLUTION_API
EVOLUTION_API_KEY=TOKEN_DA_EVOLUTION_API
EVOLUTION_INSTANCE_NAME=NOME_DA_INSTANCIA
EVOLUTION_WEBHOOK_SECRET=OUTRO_SEGREDO_LONGO_E_ALEATORIO
PIX_KEY=CHAVE_PIX
PIX_RECEIVER=NOME_DO_RECEBEDOR
WHATSAPP_PAYMENTS_ENABLED=false
PAYMENT_GATE_ENABLED=false
```

O número admin deve conter apenas dígitos, incluindo país e DDD. Mais de um número pode ser separado por vírgula.

## Webhook na Evolution API

Cadastre:

- URL: `BACKEND_URL/api/webhooks/evolution`
- Evento: `MESSAGES_UPSERT`
- Cabeçalho: `x-evolution-webhook-secret`
- Valor do cabeçalho: o mesmo valor de `EVOLUTION_WEBHOOK_SECRET`

Não coloque o segredo na URL. Ele pode aparecer em logs e históricos.

## Ativação

Depois que todas as variáveis e o Volume estiverem prontos:

1. Altere `WHATSAPP_PAYMENTS_ENABLED=true`.
2. Altere `PAYMENT_GATE_ENABLED=true` no mesmo deploy.
3. Aguarde o deploy terminar.
4. Abra `BACKEND_URL/health` e confirme `payments.enabled: true` e `payments.configured: true`.
5. Execute o teste completo com dois jogadores.

Os dois controles precisam estar ativos e a configuração precisa estar completa. Se algo estiver incompleto, o sistema financeiro não é ativado e o jogo atual continua disponível.

## Comandos de emergência

Somente os números de `ADMIN_WHATSAPP_NUMBERS` podem usar:

```text
/admin pendentes
/admin confirmar 1023
/admin rejeitar 1023 motivo da rejeição
```

Um número não autorizado recebe somente `Comando não autorizado.`

## Checklist de teste real

- [ ] Jogador envia `oi` e recebe o menu.
- [ ] Jogador escolhe uma mesa e recebe as instruções do Pix.
- [ ] Jogador envia imagem ou PDF do comprovante.
- [ ] Pagamento continua como `pending`.
- [ ] Mesa não pode mais ser alterada.
- [ ] Admin encontra o pagamento no painel e em `/admin pendentes`.
- [ ] Número não autorizado não executa comando admin.
- [ ] Admin confirma e o jogador recebe o link.
- [ ] Link abre exatamente a mesa paga.
- [ ] Dois links confirmados entram na partida.
- [ ] Link ausente ou inválido não conecta ao multiplayer.
- [ ] Segunda confirmação do mesmo pagamento falha.
- [ ] Rejeição registra motivo e avisa o jogador.

## Desativação de emergência

Se houver qualquer dúvida financeira, altere os dois controles para `false` e faça redeploy:

```env
WHATSAPP_PAYMENTS_ENABLED=false
PAYMENT_GATE_ENABLED=false
```

Isso desativa o fluxo de pagamento sem alterar o motor, as regras ou as partidas do Pife.
