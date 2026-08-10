function money(value) {
  return `R$${Number(value || 0).toFixed(2).replace('.', ',')}`;
}

function tableLabel(value, demoCreditsEnabled = false) {
  return demoCreditsEnabled
    ? `${Number(value || 0)} Créditos de Teste`
    : money(value);
}

function tableInSentence(value, demoCreditsEnabled = false) {
  return demoCreditsEnabled
    ? `Mesa de ${tableLabel(value, true)}`
    : `Mesa ${tableLabel(value, false)}`;
}

function optionalReference(publicReference) {
  return publicReference ? `\nReferência: *${publicReference}*` : '';
}

export const WHATSAPP_PLAYER_STATES = Object.freeze({
  IDLE: 'IDLE',
  WAITING_FOR_OPPONENT: 'WAITING_FOR_OPPONENT',
  MATCH_LINK_READY: 'MATCH_LINK_READY',
  PRE_MATCH_WAITING: 'PRE_MATCH_WAITING',
  MATCH_STARTED: 'MATCH_STARTED',
  MATCH_FINISHED: 'MATCH_FINISHED',
  ADMIN_REVIEW: 'ADMIN_REVIEW',
  REFUND_PENDING: 'REFUND_PENDING',
});

export function mainMenu({ paymentsEnabled = false, demoCreditsEnabled = false } = {}) {
  return [
    '*🎴 PIFE DUELO*',
    '_Seu lobby pelo WhatsApp_',
    '',
    '🎮 *1 — Jogar*',
    '',
    '🧭 *2 — Como funciona*',
    '',
    '📜 *3 — Regras do Pife*',
    '',
    '🛟 *4 — Suporte*',
    '',
    '📢 *5 — Atualizações*',
    '',
    ...(demoCreditsEnabled ? ['🧪 *6 — Meus Créditos de Teste*', ''] : []),
    paymentsEnabled
      ? '👇 _Digite o número da opção._'
      : demoCreditsEnabled
        ? '🧪 _Simulação com Créditos de Teste, sem valor em dinheiro._'
        : '🆓 _Fase de testes gratuitos: sem cobrança e sem prêmio real._',
  ].join('\n');
}

export function howItWorksMenu({ paymentsEnabled = false } = {}) {
  return [
    '*COMO FUNCIONA*',
    '',
    '1. Escolha uma Mesa pelo WhatsApp.',
    '2. Aguarde um adversário da mesma Mesa.',
    '3. Quando a Sala de espera estiver pronta, os dois recebem o acesso.',
    '4. A Partida começa quando os dois jogadores entram.',
    '5. Ao terminar, sua Entrada é liberada para jogar novamente.',
    '',
    paymentsEnabled
      ? '_A situação da sua Entrada será informada antes de cada etapa._'
      : '_Neste momento os testes são gratuitos, sem cobrança e sem prêmio real._',
    '',
    'Digite *jogar* para escolher uma Mesa.',
    'Digite *teste* para conhecer a gameplay grátis.',
    'Digite *menu* para voltar.',
  ].join('\n');
}

export function tablesMenu({ paymentsEnabled = false, demoCreditsEnabled = false, demoBalance = null } = {}) {
  if (demoCreditsEnabled) {
    return [
      '*🃏 ESCOLHA UMA MESA*',
      '',
      `🧪 Seu saldo: *${Number(demoBalance ?? 0)} Créditos de Teste*`,
      '',
      '1️⃣ *Mesa 1*',
      'Entrada: 2 Créditos de Teste',
      '',
      '2️⃣ *Mesa 2*',
      'Entrada: 5 Créditos de Teste',
      '',
      '3️⃣ *Mesa 3*',
      'Entrada: 10 Créditos de Teste',
      '',
      '4️⃣ *Mesa 4*',
      'Entrada: 20 Créditos de Teste',
      '',
      '⚠️ Os Créditos de Teste não possuem valor em dinheiro e servem apenas para testar o funcionamento do Pife Duelo.',
      '',
      '↩️ Digite *menu* para voltar.',
    ].join('\n');
  }
  return [
    '*🃏 ESCOLHA UMA MESA*',
    '_Digite o número da categoria:_',
    '',
    `1️⃣ *Mesa ${money(2)}*`,
    '',
    `2️⃣ *Mesa ${money(5)}*`,
    '',
    `3️⃣ *Mesa ${money(10)}*`,
    '',
    `4️⃣ *Mesa ${money(20)}*`,
    '',
    paymentsEnabled
      ? '🔐 _A situação da Entrada será confirmada antes de seguir._'
      : '🆓 _Nenhum valor será cobrado e não há prêmio real nesta fase._',
    '',
    '↩️ Digite *menu* para voltar.',
  ].join('\n');
}

export function demoCreditsBalanceMenu({ availableBalance, reservedBalance }) {
  return [
    '*🧪 MEUS CRÉDITOS DE TESTE*',
    '',
    `✅ Disponível: *${Number(availableBalance ?? 0)}*`,
    '',
    `🔒 Reservado em partidas: *${Number(reservedBalance ?? 0)}*`,
    '',
    'Os Créditos de Teste não possuem valor em dinheiro, não podem ser comprados, transferidos ou sacados.',
    '',
    '📋 *1 — Ver histórico recente*',
    '',
    'ℹ️ *2 — Como funcionam os créditos*',
    '',
    '↩️ Digite *menu* para voltar.',
  ].join('\n');
}

export function demoCreditsInitialGrant(amount) {
  return [
    `🧪 Você recebeu *${Number(amount)} Créditos de Teste*.` ,
    '',
    'Eles não possuem valor em dinheiro e servem apenas para testar o Pife Duelo.',
  ].join('\n');
}

export function demoCreditsExplanation() {
  return [
    '*ℹ️ COMO FUNCIONAM OS CRÉDITOS DE TESTE*',
    '',
    '• São concedidos gratuitamente para validar o sistema.',
    '',
    '• Ao entrar em uma fila, o custo da Mesa fica reservado.',
    '',
    '• A reserva só é consumida quando os dois jogadores iniciam a Partida.',
    '',
    '• Se a espera for cancelada antes do início, a reserva volta ao saldo disponível.',
    '',
    '• O vencedor recebe apenas uma recompensa fictícia de teste.',
    '',
    '⚠️ Não possuem valor em dinheiro e não podem ser comprados, vendidos, transferidos ou sacados.',
    '',
    '↩️ Digite *menu* para voltar.',
  ].join('\n');
}

export function demoCreditsHistory(events = []) {
  const labels = {
    DEMO_INITIAL_GRANT: 'Saldo inicial de teste',
    DEMO_ADMIN_GRANT: 'Concessão administrativa',
    DEMO_ENTRY_RESERVED: 'Entrada reservada',
    DEMO_ENTRY_RELEASED: 'Reserva devolvida',
    DEMO_ENTRY_CONSUMED: 'Entrada iniciada',
    DEMO_MATCH_REWARD: 'Vitória na partida',
    DEMO_SYSTEM_COMPENSATION: 'Compensação por falha do sistema',
    DEMO_ACCOUNT_RESET: 'Conta de teste reiniciada',
  };
  const lines = events.length
    ? events.map((event) => {
      const positive = ['DEMO_INITIAL_GRANT', 'DEMO_ADMIN_GRANT', 'DEMO_ENTRY_RELEASED', 'DEMO_MATCH_REWARD', 'DEMO_SYSTEM_COMPENSATION'].includes(event.type);
      const prefix = positive ? '+' : event.type === 'DEMO_ENTRY_CONSUMED' ? '•' : '-';
      return `${prefix}${Number(event.amount)} — ${labels[event.type] || 'Operação de teste'}${event.publicReference ? ` (${event.publicReference})` : ''}`;
    })
    : ['Nenhuma movimentação registrada.'];
  return [
    '*📋 HISTÓRICO RECENTE*',
    '',
    ...lines,
    '',
    '⚠️ Créditos fictícios, gratuitos e sem valor em dinheiro.',
    '',
    '↩️ Digite *menu* para voltar.',
  ].join('\n');
}

export function demoCreditsInsufficient({ availableBalance, requiredAmount }) {
  return [
    '*⚠️ CRÉDITOS INSUFICIENTES*',
    '',
    'Você não possui Créditos de Teste suficientes para esta Mesa.',
    '',
    `Saldo atual: *${Number(availableBalance ?? 0)}*`,
    `Custo da Mesa: *${Number(requiredAmount ?? 0)}*`,
    '',
    'Digite *jogar* para escolher outra Mesa ou *suporte* se precisar de ajuda.',
  ].join('\n');
}

export function testModeMessage(testModeLink) {
  return [
    '*🎮 MODO TESTE GRÁTIS*',
    '',
    'Conheça a gameplay sem entrar na fila de uma Mesa.',
    '',
    '• Sem Pix',
    '• Sem aposta',
    '• Sem prêmio',
    '• Não cria Entrada paga',
    '',
    'Acesse:',
    testModeLink,
    '',
    'Digite *menu* para ver outras opções.',
  ].join('\n');
}

export function rulesMenu() {
  return [
    '*📜 REGRAS DO PIFE*',
    '',
    '🎯 *1 — Objetivo*',
    '',
    '🔄 *2 — Como funciona o turno*',
    '',
    '🃏 *3 — Combinações válidas*',
    '',
    '🏁 *4 — Como bater*',
    '',
    '🚪 *5 — Cancelamento e desistência*',
    '',
    '📚 *6 — Ver todas as regras*',
    '',
    '↩️ Digite *menu* para voltar.',
  ].join('\n');
}

const RULE_TOPICS = Object.freeze({
  '1': [
    '*OBJETIVO*',
    '',
    'Forme *três combinações válidas* usando nove cartas.',
    'Depois de comprar, sua décima carta fica como carta restante para a batida.',
  ],
  '2': [
    '*COMO FUNCIONA O TURNO*',
    '',
    'No seu turno, compre uma carta do monte ou do descarte.',
    'Depois, escolha entre bater com a mão válida ou descartar uma carta para continuar a Partida.',
  ],
  '3': [
    '*COMBINAÇÕES VÁLIDAS*',
    '',
    '• Sequência: três cartas consecutivas do mesmo naipe.',
    '• Trinca: três cartas do mesmo valor e de naipes diferentes.',
    '• Pares não formam um grupo completo.',
    '• A mesma carta não pode participar de dois grupos.',
  ],
  '4': [
    '*COMO BATER*',
    '',
    'Compre primeiro. Se as nove cartas formarem três grupos válidos e sobrar uma carta, use *BATER* antes do descarte.',
    'Os círculos são apenas uma ajuda visual para grupos organizados lado a lado.',
  ],
  '5': [
    '*CANCELAMENTO E DESISTÊNCIA*',
    '',
    'Antes de a Partida começar, o cancelamento pode ser permitido conforme a situação da Entrada.',
    'Depois que a Partida começou, sair é Desistência e deve ser tratado dentro da Partida ou pelo suporte.',
    'Digite *status* para consultar sua situação antes de cancelar.',
  ],
});

export function allRules() {
  return [
    '*TODAS AS REGRAS*',
    '',
    '• Forme três combinações usando nove cartas.',
    '• Compre uma carta no início do seu turno.',
    '• Bata depois da compra e antes do descarte.',
    '• Sequências precisam ser consecutivas e do mesmo naipe.',
    '• Trincas têm o mesmo valor e três naipes diferentes.',
    '• Pares não são grupos completos.',
    '• Uma carta não pode ser reutilizada em outro grupo.',
    '• Se descartar sem bater, a Partida continua.',
    '• Sair depois que a Partida começou é Desistência.',
    '• Os círculos são apenas ajuda visual de organização.',
    '',
    'Digite *regras* para escolher um tópico ou *menu* para voltar.',
  ].join('\n');
}

export function ruleTopic(topic) {
  const lines = topic === '6' ? null : RULE_TOPICS[String(topic)];
  if (String(topic) === '6') return allRules();
  if (!lines) return rulesMenu();
  return [...lines, '', 'Digite *regras* para ver os tópicos ou *menu* para voltar.'].join('\n');
}

export function supportMenu({ publicReference = null } = {}) {
  return [
    '*🛟 SUPORTE PIFE DUELO*',
    ...(publicReference ? ['', `Referência: *${publicReference}*`] : []),
    '',
    '🔗 *1 — Link não abre*',
    '',
    '👥 *2 — Adversário não entrou*',
    '',
    '⚠️ *3 — Partida travou*',
    '',
    '📶 *4 — Fui desconectado*',
    '',
    '🎟️ *5 — Problema com Entrada*',
    '',
    '👤 *6 — Falar com o suporte*',
    '',
    '↩️ Digite *menu* para voltar.',
  ].join('\n');
}

const SUPPORT_TOPICS = Object.freeze({
  '1': 'Abra o link no navegador padrão do celular. Se ele expirou, digite *link* para verificar se um novo acesso pode ser gerado.',
  '2': 'Permaneça na Sala de espera e digite *status*. Se o tempo de entrada terminar, o sistema protege e libera a situação conforme as regras atuais.',
  '3': 'Atualize a página uma vez e aguarde a reconexão. Sua Partida continua protegida; se não voltar, fale com o suporte.',
  '4': 'Abra novamente o mesmo acesso e aguarde a reconexão. Não escolha outra Mesa enquanto a Partida estiver ativa.',
  '5': 'Digite *status* para consultar a Entrada. Não envie dados sensíveis, tokens ou links completos no atendimento.',
});

export function supportTopic(topic, { publicReference = null } = {}) {
  const guidance = SUPPORT_TOPICS[String(topic)];
  if (!guidance) return supportMenu({ publicReference });
  return [
    '*AJUDA RÁPIDA*',
    optionalReference(publicReference).trim(),
    '',
    guidance,
    '',
    'Não resolveu? Digite *6* para falar com o suporte.',
    'Digite *suporte* para voltar aos tópicos ou *menu* para voltar.',
  ].filter(Boolean).join('\n');
}

export function supportContact({ supportLink = '', publicReference = null, hasActiveContext = false } = {}) {
  return [
    '*📞 ATENDIMENTO PIFE DUELO*',
    optionalReference(publicReference).trim(),
    '',
    supportLink
      ? 'Toque no link para falar com o suporte:'
      : 'O link direto está temporariamente indisponível. Descreva o problema nesta conversa.',
    supportLink,
    '',
    'Informe a Mesa escolhida, o que aconteceu e, se possível, um print do erro.',
    hasActiveContext
      ? '_Identificamos uma situação ativa. Procure o suporte antes de sair ou tentar outra Mesa._'
      : '_Nunca envie senha, token ou código de acesso completo._',
  ].filter(Boolean).join('\n');
}

export function waitingForOpponent({ table, demoCreditsEnabled = false, availableBalance = null, reservedAmount = null }) {
  const hasAvailableBalance = availableBalance !== null
    && availableBalance !== undefined
    && Number.isFinite(Number(availableBalance));
  return [
    '*⏳ AGUARDANDO ADVERSÁRIO*',
    '',
    `Você está aguardando na ${tableInSentence(table, demoCreditsEnabled)}.`,
    ...(demoCreditsEnabled ? [
      `Créditos reservados: ${Number(reservedAmount ?? table ?? 0)}`,
      ...(hasAvailableBalance ? [`Saldo disponível: ${Number(availableBalance)}`] : []),
      '',
    ] : []),
    'Assim que outro jogador escolher a mesma Mesa, a Sala de espera será preparada.',
    '',
    '🔎 *status* — consultar a espera',
    '',
    '❌ *cancelar* — pedir cancelamento antes do início',
    '',
    '🏠 *menu* — ver opções seguras',
    '',
    '🛟 *suporte* — pedir ajuda',
  ].join('\n');
}

export function queueDuplicate({ table, demoCreditsEnabled = false }) {
  return [
    '*AGUARDANDO ADVERSÁRIO*',
    '',
    `Você já está na ${tableInSentence(table, demoCreditsEnabled)}.`,
    'Não criamos uma segunda Entrada.',
    '',
    'Digite *status*, *cancelar* ou *suporte*.',
  ].join('\n');
}

export function otherQueue({ table, demoCreditsEnabled = false }) {
  return [
    '*ENTRADA JÁ ATIVA*',
    '',
    `Você já está aguardando na ${tableInSentence(table, demoCreditsEnabled)}.`,
    'Para trocar de Mesa, digite *cancelar* e confirme antes do início.',
  ].join('\n');
}

export function matchLinkReady({ table, publicReference = null, demoCreditsEnabled = false }) {
  return [
    '*🔗 SALA DE ESPERA PRONTA*',
    '',
    `Mesa: ${tableLabel(table, demoCreditsEnabled)}`,
    publicReference ? `Referência: *${publicReference}*` : '',
    'Seu acesso já foi preparado. Não entre novamente na fila.',
    '',
    '*link* — recuperar o acesso quando permitido',
    '*status* — consultar a situação',
    '*suporte* — pedir ajuda',
  ].filter(Boolean).join('\n');
}

export function preMatchWaiting({ table, publicReference = null, demoCreditsEnabled = false }) {
  return [
    '*SALA DE ESPERA*',
    '',
    `Mesa: ${tableLabel(table, demoCreditsEnabled)}`,
    publicReference ? `Referência: *${publicReference}*` : '',
    'Aguarde os dois jogadores entrarem. A Partida ainda não começou.',
    '',
    '*status* — consultar',
    '*link* — recuperar acesso quando permitido',
    '*suporte* — pedir ajuda',
  ].filter(Boolean).join('\n');
}

export function activeMatch({ table, publicReference = null, demoCreditsEnabled = false }) {
  return [
    '*🎮 PARTIDA ATIVA*',
    '',
    table ? `Mesa: ${tableLabel(table, demoCreditsEnabled)}` : '',
    publicReference ? `Referência: *${publicReference}*` : '',
    'Finalize a Partida antes de escolher outra Mesa.',
    'Sair agora pode ser tratado como Desistência.',
    '',
    'Digite *status*, *regras* ou *suporte*.',
  ].filter(Boolean).join('\n');
}

export function matchFinished() {
  return [
    '*✅ PARTIDA ENCERRADA*',
    '',
    'Sua Partida anterior foi finalizada e você pode escolher uma nova Mesa.',
    '',
    'Digite *jogar* para começar novamente ou *menu* para ver as opções.',
  ].join('\n');
}

export function adminReview({ table, publicReference = null }) {
  return [
    '*ENTRADA EM REVISÃO*',
    '',
    table ? `Mesa: ${money(table)}` : '',
    publicReference ? `Referência: *${publicReference}*` : '',
    'Sua Entrada está preservada e precisa de análise do suporte/admin.',
    'Não crie outra Entrada nem tente trocar de Mesa agora.',
    '',
    'Digite *suporte* para pedir ajuda.',
  ].filter(Boolean).join('\n');
}

export function refundPending({ table, publicReference = null }) {
  return [
    '*REVISÃO DE REEMBOLSO*',
    '',
    table ? `Mesa: ${money(table)}` : '',
    publicReference ? `Referência: *${publicReference}*` : '',
    'Sua solicitação está preservada para análise manual.',
    'Nenhum reembolso automático será feito por este menu.',
    '',
    'Digite *suporte* para acompanhar.',
  ].filter(Boolean).join('\n');
}

export function cancelConfirmation({ table, demoCreditsEnabled = false }) {
  return [
    '*⚠️ CONFIRMAR CANCELAMENTO*',
    '',
    `Você está aguardando na ${tableInSentence(table, demoCreditsEnabled)}.`,
    'Deseja realmente cancelar a espera?',
    '',
    '⏳ *1 — Continuar aguardando*',
    '',
    '❌ *2 — Cancelar e voltar ao menu*',
    '',
    '↩️ Digite *menu* para voltar sem cancelar.',
  ].join('\n');
}

export function cancellationProtocol({ publicReference = null } = {}) {
  return [
    '*✅ ENTRADA CANCELADA*',
    '',
    'O cancelamento foi confirmado antes do início da Partida.',
    publicReference ? `Protocolo: *${publicReference}*` : 'A Entrada foi liberada com segurança.',
    'Você já pode escolher outra Mesa.',
  ].filter(Boolean).join('\n');
}

export function paidEntryActive({ table, demoCreditsEnabled = false }) {
  return [
    '*ENTRADA PRESERVADA*',
    '',
    table ? `Mesa: ${tableLabel(table, demoCreditsEnabled)}` : '',
    'Esta Entrada não pode ser cancelada automaticamente.',
    'Aguarde o início ou fale com o suporte/admin.',
  ].filter(Boolean).join('\n');
}

export function matchFound({ table, accessLink, publicReference = null, demoCreditsEnabled = false }) {
  return [
    '*🎮 Partida encontrada!*',
    '',
    `Mesa: ${tableLabel(table, demoCreditsEnabled)}`,
    publicReference ? `Referência: *${publicReference}*` : '',
    'Sua Sala de espera está pronta.',
    'Entre na sala pelo link abaixo:',
    '',
    accessLink,
    '',
    '_Este link é individual. Não encaminhe para outras pessoas._',
  ].filter(Boolean).join('\n');
}

export function invalidCommand() {
  return [
    '*NÃO ENTENDI ESSA OPÇÃO*',
    '',
    'Digite *menu* para ver as opções, *status* para consultar sua situação ou *suporte* para pedir ajuda.',
  ].join('\n');
}

export function friendlyActionError() {
  return [
    '*NÃO FOI POSSÍVEL CONCLUIR AGORA*',
    '',
    'Sua situação continua protegida. Tente novamente em instantes ou digite *suporte*.',
  ].join('\n');
}

export function unavailableLink() {
  return [
    '*LINK INDISPONÍVEL*',
    '',
    'Este link não está mais disponível.',
    'Digite *status* para consultar sua situação ou *jogar* para começar novamente quando estiver liberado.',
  ].join('\n');
}

export function postMatchPlayerResult(report, won) {
  if (report.demoCreditsEnabled) {
    const currentPlayerId = won ? report.winnerId : report.loserId;
    const balance = report.demoCredits?.balances?.find((item) => item.matchPlayerId === currentPlayerId)?.balance;
    return [
      won ? '*🏆 VITÓRIA CONFIRMADA*' : '*🎴 PARTIDA ENCERRADA*',
      '',
      `Mesa: ${Number(report.table || 0)} Créditos de Teste`,
      `Resultado: ${won ? 'Vitória' : 'Derrota'}`,
      `Duração: ${report.durationLabel}`,
      report.publicReference ? `Referência: *${report.publicReference}*` : '',
      '',
      won
        ? `Você recebeu ${Number(report.demoCredits?.rewardAmount || 0)} Créditos de Teste.`
        : `${Number(report.table || 0)} Créditos de Teste foram utilizados nesta entrada.`,
      Number.isFinite(balance) ? `Novo saldo: ${balance}` : '',
      '',
      'Esses créditos não possuem valor em dinheiro.',
      'Digite *jogar* para escolher uma Mesa ou *menu* para ver as opções.',
    ].filter(Boolean).join('\n');
  }
  return [
    won ? '*🏆 VOCÊ VENCEU NO PIFE DUELO*' : '*🎴 PARTIDA ENCERRADA*',
    '',
    `Mesa: ${report.tableLabel}`,
    `Resultado: ${won ? 'Vitória' : 'Derrota'}`,
    `Duração: ${report.durationLabel}`,
    report.publicReference ? `Referência: *${report.publicReference}*` : '',
    '',
    'Sua Entrada foi liberada e você já pode jogar novamente.',
    '',
    'Digite *jogar* para escolher uma Mesa ou *menu* para ver as opções.',
  ].filter(Boolean).join('\n');
}

export function postMatchAdminReport(report, { queueCleaned, entriesReleased, entryStatuses = [] }) {
  const winnerName = report.winner?.name ?? 'Não identificado';
  const loserName = report.loser?.name ?? 'Não identificado';
  const participants = report.participantLabels?.length
    ? report.participantLabels.join(' / ')
    : 'não identificados';
  return [
    '*📋 PARTIDA FINALIZADA*',
    '',
    `Referência: ${report.publicReference}`,
    `Mesa: ${report.tableLabel}`,
    `Início: ${report.startedAtLabel}`,
    `Fim: ${report.finishedAtLabel}`,
    `Duração: ${report.durationLabel}`,
    `Jogadores: ${participants}`,
    '',
    `Vencedor: ${winnerName} / ${report.winnerLabel || 'não identificado'}`,
    `Perdedor: ${loserName} / ${report.loserLabel || 'não identificado'}`,
    `Motivo: ${report.reasonLabel}`,
    '',
    `Fila limpa: ${queueCleaned ? 'SIM' : 'NÃO/APENAS WEB'}`,
    `Entradas liberadas: ${entriesReleased ? 'SIM' : 'NÃO/APENAS WEB'}`,
    `Status das entradas: ${entryStatuses.length ? entryStatuses.join(' / ') : 'não vinculado'}`,
    `Estado da Partida: ${report.terminalStatus || 'finished'}`,
    ...(report.demoCreditsEnabled ? [
      '',
      '*AMBIENTE DEMONSTRATIVO — SEM VALOR FINANCEIRO*',
      `Custo em créditos: ${Number(report.table || 0)}`,
      `Recompensa fictícia: ${Number(report.demoCredits?.rewardAmount || 0)}`,
      `Compensações: ${Number(report.demoCredits?.compensatedPlayers || 0)}`,
    ] : []),
  ].join('\n');
}
