export const PUBLIC_ROADMAP_STATUS = Object.freeze({
  AVAILABLE: 'AVAILABLE',
  TESTING: 'TESTING',
  PLANNED: 'PLANNED',
  STUDY: 'STUDY',
  PAUSED: 'PAUSED',
});

export const PUBLIC_ROADMAP_STATUS_LABELS = Object.freeze({
  [PUBLIC_ROADMAP_STATUS.AVAILABLE]: '✅ Disponível',
  [PUBLIC_ROADMAP_STATUS.TESTING]: '🧪 Em testes',
  [PUBLIC_ROADMAP_STATUS.PLANNED]: '🛠️ Planejado',
  [PUBLIC_ROADMAP_STATUS.STUDY]: '🔎 Em estudo',
  [PUBLIC_ROADMAP_STATUS.PAUSED]: '⏸️ Pausado',
});

// Atualize somente esta lista. Use publicVisible=false para ocultar um item e
// requiredFlags para impedir divulgação antes da ativação real de um recurso.
export const PUBLIC_ROADMAP = Object.freeze([
  { id: 'online-one-versus-one', title: 'Partidas online 1 contra 1', status: PUBLIC_ROADMAP_STATUS.AVAILABLE, description: 'Partidas competitivas entre dois jogadores.', publicVisible: true, order: 10 },
  { id: 'whatsapp-first-lobby', title: 'WhatsApp como entrada principal', status: PUBLIC_ROADMAP_STATUS.AVAILABLE, description: 'Menu, orientação e acesso às partidas pelo bot oficial.', publicVisible: true, order: 20 },
  { id: 'individual-match-links', title: 'Links individuais para as partidas', status: PUBLIC_ROADMAP_STATUS.AVAILABLE, description: 'Cada jogador recebe seu próprio acesso à sala.', publicVisible: true, order: 30 },
  { id: 'player-reconnection', title: 'Reconexão após perda de conexão', status: PUBLIC_ROADMAP_STATUS.AVAILABLE, description: 'Proteção para retornos após uma interrupção temporária.', publicVisible: true, order: 40 },
  { id: 'pre-match-waiting-room', title: 'Sala de espera antes do início', status: PUBLIC_ROADMAP_STATUS.AVAILABLE, description: 'A partida aguarda os dois jogadores antes de começar.', publicVisible: true, order: 50 },
  { id: 'free-training-mode', title: 'Modo de treinamento gratuito', status: PUBLIC_ROADMAP_STATUS.AVAILABLE, description: 'Treinamento separado das filas reais e sem prêmio.', publicVisible: true, order: 60 },
  { id: 'result-and-whatsapp-return', title: 'Resultado e retorno ao WhatsApp', status: PUBLIC_ROADMAP_STATUS.AVAILABLE, description: 'Resultado final claro e retorno seguro ao bot.', publicVisible: true, order: 70 },
  { id: 'closed-beta', title: 'Beta fechado com jogadores reais', status: PUBLIC_ROADMAP_STATUS.TESTING, description: 'Validação controlada da experiência completa.', publicVisible: true, order: 110 },
  { id: 'stability-improvements', title: 'Melhorias de estabilidade', status: PUBLIC_ROADMAP_STATUS.TESTING, description: 'Ajustes baseados nos testes reais.', publicVisible: true, order: 120 },
  { id: 'match-monitoring', title: 'Monitoramento de partidas', status: PUBLIC_ROADMAP_STATUS.TESTING, description: 'Acompanhamento técnico para detectar falhas.', publicVisible: true, order: 130 },
  { id: 'chatbot-experience', title: 'Ajustes na experiência do chatbot', status: PUBLIC_ROADMAP_STATUS.TESTING, description: 'Conversa mais clara e com menos mensagens acumuladas.', publicVisible: true, order: 140 },
  { id: 'exit-and-reconnection-flows', title: 'Melhorias nos fluxos de desistência e reconexão', status: PUBLIC_ROADMAP_STATUS.TESTING, description: 'Proteção do estado dos jogadores em situações de saída.', publicVisible: true, order: 150 },
  {
    id: 'four-player-mode',
    title: 'Modalidade para 4 jogadores',
    status: PUBLIC_ROADMAP_STATUS.STUDY,
    description: 'Uma futura modalidade separada, utilizando as mesmas regras principais do Pife Duelo. O modo 1 contra 1 continuará disponível.',
    publicVisible: true,
    order: 210,
  },
  { id: 'player-match-history', title: 'Histórico de partidas do jogador', status: PUBLIC_ROADMAP_STATUS.STUDY, description: 'Consulta individual do histórico pelo próprio jogador.', publicVisible: true, order: 220 },
  { id: 'new-competition-features', title: 'Novos recursos de competição', status: PUBLIC_ROADMAP_STATUS.STUDY, description: 'Novas formas de competição ainda sem escopo ou data definidos.', publicVisible: true, order: 230 },
]);

function featureEnabled(featureFlags, flag) {
  return featureFlags?.[flag] === true;
}

export function getPublicRoadmap({ featureFlags = {}, items = PUBLIC_ROADMAP } = {}) {
  return items
    .filter((item) => item?.publicVisible === true)
    .filter((item) => (item.requiredFlags || []).every((flag) => featureEnabled(featureFlags, flag)))
    .filter((item) => PUBLIC_ROADMAP_STATUS_LABELS[item.status])
    .sort((left, right) => Number(left.order || 0) - Number(right.order || 0));
}

function itemsForStatus(statuses, options = {}) {
  const accepted = new Set(statuses);
  return getPublicRoadmap(options).filter((item) => accepted.has(item.status));
}

function itemLine(item, { includeDescription = false } = {}) {
  const status = PUBLIC_ROADMAP_STATUS_LABELS[item.status];
  if (!includeDescription) return `• ${item.title}`;
  return `${status} — *${item.title}*\n${item.description}`;
}

export function publicUpdatesMenu(_options = {}) {
  // O painel inicial deve ser curto. Os detalhes ficam nas três seções abaixo.
  return [
    '*📢 ATUALIZAÇÕES DO PIFE DUELO*',
    '_Escolha o que deseja consultar:_',
    '',
    '✅ *1 — Novidades disponíveis*',
    '',
    '🔎 *2 — Próximos recursos*',
    '',
    '📊 *3 — Status do projeto*',
    '',
    '↩️ Digite *menu* para voltar ao início.',
  ].join('\n');
}

export function availableUpdates(options = {}) {
  const items = itemsForStatus([PUBLIC_ROADMAP_STATUS.AVAILABLE], options);
  return [
    '*✅ NOVIDADES DISPONÍVEIS*', '',
    ...items.map((item) => itemLine(item, { includeDescription: true })), '',
    'Digite *atualizações* para voltar ou *menu* para o início.',
  ].join('\n');
}

export function upcomingUpdates(options = {}) {
  const items = itemsForStatus([
    PUBLIC_ROADMAP_STATUS.TESTING,
    PUBLIC_ROADMAP_STATUS.PLANNED,
    PUBLIC_ROADMAP_STATUS.STUDY,
    PUBLIC_ROADMAP_STATUS.PAUSED,
  ], options);
  return [
    '*🔎 PRÓXIMOS RECURSOS*', '',
    ...items.map((item) => itemLine(item, { includeDescription: true })), '',
    '_Não há datas confirmadas. Cada mudança depende de validação técnica e testes._', '',
    'Digite *atualizações* para voltar ou *menu* para o início.',
  ].join('\n');
}

export function publicProjectStatus({ featureFlags = {} } = {}) {
  const financialEnabled = featureEnabled(featureFlags, 'paymentsEnabled')
    && featureEnabled(featureFlags, 'whatsappPaymentsEnabled')
    && featureEnabled(featureFlags, 'gateEnabled');
  return [
    '*📊 STATUS DO PROJETO*', '',
    'O Pife Duelo está atualmente em fase de beta fechado gratuito.',
    'Estamos validando estabilidade, reconexão, partidas online e experiência dos jogadores antes de liberar novas etapas.', '',
    financialEnabled
      ? 'Recursos financeiros só são exibidos quando todas as proteções necessárias estão ativas.'
      : '_Pagamentos, Pix e prêmios reais não estão disponíveis nesta fase._', '',
    'Digite *atualizações* para voltar ou *menu* para o início.',
  ].join('\n');
}
