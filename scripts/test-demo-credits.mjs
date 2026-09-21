import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DemoCreditsRepository } from '../server/src/demoCredits/DemoCreditsRepository.js';
import { DemoCreditsService } from '../server/src/demoCredits/DemoCreditsService.js';
import { WhatsAppEntryStore } from '../server/src/entries/WhatsAppEntryStore.js';
import { WhatsAppEntryService } from '../server/src/entries/WhatsAppEntryService.js';
import { MatchQueue } from '../server/src/services/matchQueue.js';
import { WhatsAppPaymentBot } from '../server/src/payments/WhatsAppPaymentBot.js';
import {
  demoCreditsExplanation,
  mainMenu,
  tablesMenu,
  waitingForOpponent,
} from '../server/src/services/whatsappMessages.js';

const phones = [
  '5521990000001',
  '5521990000002',
  '5521990000003',
  '5521990000004',
  '5521990000005',
  '5521990000006',
  '5521990000007',
  '5521990000008',
];

function createService({ repository = new DemoCreditsRepository(), enabled = true, startingBalance = 100 } = {}) {
  return new DemoCreditsService({ repository, enabled, startingBalance, historyLimit: 50 });
}

function expectCode(fn, code) {
  assert.throws(fn, (error) => error?.message === code);
}

const service = createService();

// Concessão inicial e consulta idempotente.
const initial = service.getBalance(phones[0]);
assert.equal(initial.availableBalance, 100);
assert.equal(initial.initialGrantApplied, true);
assert.equal(service.getBalance(phones[0]).initialGrantApplied, false);
assert.equal(service.getHistory(phones[0]).filter((event) => event.type === 'DEMO_INITIAL_GRANT').length, 1);

// Reserva, duplicidade, bloqueio simultâneo e liberação.
const referenceOne = { publicReference: 'DEMO-ENTRY-E1', entryId: 'E1', tableId: 5 };
const reserved = service.reserveCredits(phones[0], 5, referenceOne);
assert.equal(reserved.account.availableBalance, 95);
assert.equal(reserved.account.reservedBalance, 5);
assert.equal(service.reserveCredits(phones[0], 5, referenceOne).duplicate, true);
expectCode(() => service.reserveCredits(phones[0], 10, {
  publicReference: 'DEMO-ENTRY-E2', entryId: 'E2', tableId: 10,
}), 'DEMO_ACTIVE_RESERVATION_EXISTS');
assert.equal(service.releaseReservation(phones[0], referenceOne, 'queue_cancelled').released, true);
assert.equal(service.releaseReservation(phones[0], referenceOne, 'queue_cancelled').duplicate, true);
assert.equal(service.getBalance(phones[0]).availableBalance, 100);
assert.equal(service.getBalance(phones[0]).reservedBalance, 0);

// Saldo insuficiente nunca produz valor negativo.
const lowBalance = createService({ startingBalance: 2 });
expectCode(() => lowBalance.reserveCredits(phones[1], 5, {
  publicReference: 'DEMO-LOW', entryId: 'LOW', tableId: 5,
}), 'DEMO_INSUFFICIENT_CREDITS');
assert.equal(lowBalance.getBalance(phones[1]).availableBalance, 2);

// Consumo atômico dos dois participantes no MATCH_STARTED.
for (const [phone, entryId] of [[phones[2], 'E3'], [phones[3], 'E4']]) {
  service.reserveCredits(phone, 5, { publicReference: `DEMO-${entryId}`, entryId, tableId: 5 });
}
const participants = [
  { playerId: phones[2], entryId: 'E3', matchPlayerId: 'P3' },
  { playerId: phones[3], entryId: 'E4', matchPlayerId: 'P4' },
];
assert.equal(service.consumeMatchReservations(participants, { matchId: 'MATCH-1', tableId: 5 }).operations.length, 2);
assert.equal(service.getBalance(phones[2]).reservedBalance, 0);
assert.equal(service.getBalance(phones[2]).availableBalance, 95);
assert.equal(service.consumeMatchReservations(participants, { matchId: 'MATCH-1', tableId: 5 }).duplicate, true);

// Recompensa fictícia e resultado duplicado.
const rewardReference = { publicReference: 'DEMO-MATCH-1', matchId: 'MATCH-1', tableId: 5, entryId: 'E3' };
assert.equal(service.rewardWinner(phones[2], 9, rewardReference).account.availableBalance, 104);
assert.equal(service.rewardWinner(phones[2], 9, rewardReference).duplicate, true);
assert.equal(service.getBalance(phones[2]).availableBalance, 104);

// SYSTEM_ABORT compensa os dois uma única vez.
for (const [phone, entryId] of [[phones[4], 'E5'], [phones[5], 'E6']]) {
  service.reserveCredits(phone, 10, { publicReference: `DEMO-${entryId}`, entryId, tableId: 10 });
}
const abortedParticipants = [
  { playerId: phones[4], entryId: 'E5', matchPlayerId: 'P5' },
  { playerId: phones[5], entryId: 'E6', matchPlayerId: 'P6' },
];
service.consumeMatchReservations(abortedParticipants, { matchId: 'MATCH-ABORT', tableId: 10 });
const compensated = service.settleMatchResult({
  matchId: 'MATCH-ABORT', tableId: 10, reason: 'SYSTEM_ABORT', participants: abortedParticipants,
});
assert.equal(compensated.compensated.length, 2);
assert.equal(service.getBalance(phones[4]).availableBalance, 100);
assert.equal(service.getBalance(phones[5]).availableBalance, 100);
assert.ok(service.settleMatchResult({
  matchId: 'MATCH-ABORT', tableId: 10, reason: 'SYSTEM_ABORT', participants: abortedParticipants,
}).compensated.every((item) => item.duplicate));
expectCode(() => service.rewardWinner(phones[0], 9, {
  publicReference: 'DEMO-UNAUTHORIZED-REWARD',
  matchId: 'MATCH-NOT-CONSUMED',
  tableId: 5,
  entryId: 'UNKNOWN',
}), 'DEMO_MATCH_REWARD_NOT_AUTHORIZED');

// Encerramento sem vencedor também compensa, mesmo com outro motivo administrativo/sistêmico.
for (const [phone, entryId] of [[phones[6], 'E7'], [phones[7], 'E8']]) {
  service.reserveCredits(phone, 20, { publicReference: `DEMO-${entryId}`, entryId, tableId: 20 });
}
const noWinnerParticipants = [
  { playerId: phones[6], entryId: 'E7', matchPlayerId: 'P7' },
  { playerId: phones[7], entryId: 'E8', matchPlayerId: 'P8' },
];
service.consumeMatchReservations(noWinnerParticipants, { matchId: 'MATCH-NO-WINNER', tableId: 20 });
const noWinnerSettlement = service.settleMatchResult({
  matchId: 'MATCH-NO-WINNER',
  tableId: 20,
  reason: 'admin_closed',
  participants: noWinnerParticipants,
});
assert.equal(noWinnerSettlement.compensated.length, 2);
assert.equal(service.getBalance(phones[6]).availableBalance, 100);
assert.equal(service.getBalance(phones[7]).availableBalance, 100);

// Operações administrativas sempre passam pelo ledger.
const grant = service.adminGrantCredits(phones[1], 50, 'beta fechado', phones[0]);
assert.equal(grant.previousBalance, 100);
assert.equal(grant.account.availableBalance, 150);
expectCode(() => service.adminGrantCredits(phones[1], -1, 'inválido', phones[0]), 'DEMO_INVALID_AMOUNT');
expectCode(() => service.adminGrantCredits(phones[1], 1.5, 'inválido', phones[0]), 'DEMO_AMOUNT_MUST_BE_INTEGER');
expectCode(() => service.adminGrantCredits(phones[1], 1, '', phones[0]), 'DEMO_ADMIN_REASON_REQUIRED');
const ledgerBeforeReset = service.getHistory(phones[1]).length;
assert.equal(service.adminResetDemoAccount(phones[1], 'reinício controlado', phones[0]).account.availableBalance, 100);
assert.ok(service.getHistory(phones[1]).length > ledgerBeforeReset);

// Reset é bloqueado enquanto existe reserva ativa.
const resetReference = { publicReference: 'DEMO-RESET-BLOCK', entryId: 'RESET-BLOCK', tableId: 2 };
service.reserveCredits(phones[1], 2, resetReference);
expectCode(() => service.adminResetDemoAccount(phones[1], 'não pode', phones[0]), 'DEMO_ACCOUNT_HAS_ACTIVE_RESERVATION');
service.releaseReservation(phones[1], resetReference);

// Persistência e recuperação após reinício.
const directory = mkdtempSync(join(tmpdir(), 'pife-demo-credits-'));
try {
  const filePath = join(directory, 'state.json');
  const firstProcess = createService({ repository: new DemoCreditsRepository({ filePath }) });
  firstProcess.reserveCredits(phones[0], 20, { publicReference: 'DEMO-PERSIST', entryId: 'PERSIST', tableId: 20 });
  const secondProcess = createService({ repository: new DemoCreditsRepository({ filePath }) });
  assert.equal(secondProcess.getBalance(phones[0]).availableBalance, 80);
  assert.equal(secondProcess.getBalance(phones[0]).reservedBalance, 20);
  assert.equal(secondProcess.getHistory(phones[0]).filter((event) => event.type === 'DEMO_ENTRY_RESERVED').length, 1);

  const invalidPath = join(directory, 'invalid.json');
  writeFileSync(invalidPath, '{invalid', 'utf8');
  assert.throws(() => new DemoCreditsRepository({ filePath: invalidPath }), /DEMO_CREDITS_STORE_INVALID/);
} finally {
  rmSync(directory, { recursive: true, force: true });
}

// Flag desligada mantém o estado atual sem conta ou bloqueio.
const disabledRepository = new DemoCreditsRepository();
const disabled = createService({ repository: disabledRepository, enabled: false });
expectCode(() => disabled.getBalance(phones[0]), 'DEMO_CREDITS_DISABLED');
expectCode(() => disabled.reserveCredits(phones[0], 2, { publicReference: 'OFF', entryId: 'OFF', tableId: 2 }), 'DEMO_CREDITS_DISABLED');
assert.equal(Object.keys(disabledRepository.snapshot().accounts).length, 0);
assert.equal(disabledRepository.snapshot().ledger.length, 0);

// Integração real da fila: reserva ao entrar e devolução ao cancelar/expirar.
const queueCredits = createService();
const entryStore = new WhatsAppEntryStore();
const entryService = new WhatsAppEntryService({
  store: entryStore,
  adminNumbers: [phones[0]],
  accessSecret: 'demo-credits-entry-secret',
  publicGameUrl: 'https://pife.example',
});
const queue = new MatchQueue({ entryService, demoCreditsService: queueCredits, preMatchTimeoutSeconds: 60 });
assert.equal((await queue.joinQueue(phones[0], 5, { replyTo: phones[0] })).blocked, false);
assert.equal(queueCredits.getBalance(phones[0]).availableBalance, 95);
assert.equal(queueCredits.getBalance(phones[0]).reservedBalance, 5);
assert.equal((await queue.clearPlayerState(phones[0], { actor: phones[0], reason: 'test_cancel' })).cleared, true);
assert.equal(queueCredits.getBalance(phones[0]).availableBalance, 100);

const first = await queue.joinQueue(phones[0], 5, { replyTo: phones[0] });
const second = await queue.joinQueue(phones[1], 5, { replyTo: phones[1] });
assert.equal(first.match, null);
assert.ok(second.match?.matchId);
assert.equal(queueCredits.getBalance(phones[0]).reservedBalance, 5);
assert.equal(queueCredits.getBalance(phones[1]).reservedBalance, 5);
assert.equal((await queue.abortMatchAndReleaseParticipants({
  matchId: second.match.matchId, reason: 'queue_timeout_before_start',
})).aborted, true);
assert.equal(queueCredits.getBalance(phones[0]).availableBalance, 100);
assert.equal(queueCredits.getBalance(phones[1]).availableBalance, 100);

// Mensagens demo nunca apresentam dinheiro real e não inventam saldo ausente.
const forbiddenFinancialLanguage = /R\$|\bPix\b|\bsaque\b|pr[eê]mio real/i;
const demoMenu = mainMenu({ paymentsEnabled: false, demoCreditsEnabled: true });
const demoTables = tablesMenu({ paymentsEnabled: false, demoCreditsEnabled: true, demoBalance: 100 });
assert.doesNotMatch(demoMenu, /Créditos de Teste/i);
assert.match(demoTables, /Mesa 1/);
assert.match(demoTables, /2 Créditos de Teste/);
assert.doesNotMatch(demoMenu, forbiddenFinancialLanguage);
assert.doesNotMatch(demoTables, forbiddenFinancialLanguage);
assert.doesNotMatch(demoCreditsExplanation(), forbiddenFinancialLanguage);
const waitingWithoutBalance = waitingForOpponent({
  table: 5,
  demoCreditsEnabled: true,
  availableBalance: null,
  reservedAmount: 5,
});
assert.doesNotMatch(waitingWithoutBalance, /Saldo disponível:/i);
assert.match(waitingWithoutBalance, /Créditos reservados: 5/i);

// Atalho secundário 6, histórico, explicação e proteção administrativa no fluxo do bot.
let demoMessageSequence = 0;
function demoWebhook(phone, text) {
  demoMessageSequence += 1;
  return {
    event: 'messages.upsert',
    instance: 'pife-duelo-bot',
    data: {
      key: {
        remoteJid: `${phone}@s.whatsapp.net`,
        fromMe: false,
        id: `demo-credits-${demoMessageSequence}`,
      },
      sender: `${phone}@s.whatsapp.net`,
      message: { conversation: text },
    },
  };
}

const sentMessages = [];
const botCredits = createService();
const bot = new WhatsAppPaymentBot({
  demoCreditsService: botCredits,
  paymentsEnabled: false,
  adminNumbers: [phones[0]],
  evolutionClient: {
    isConfigured: () => true,
    sendWhatsAppMessage: async (target, text) => {
      sentMessages.push({ target, text });
      return { ok: true, sent: true };
    },
  },
});
assert.equal((await bot.handleConnectivityWebhook(demoWebhook(phones[1], 'menu'))).type, 'whatsapp_menu_sent');
assert.doesNotMatch(sentMessages.at(-1).text, /Créditos de Teste/i);
assert.equal((await bot.handleConnectivityWebhook(demoWebhook(phones[1], '6'))).type, 'demo_credits_balance_sent');
assert.match(sentMessages.at(-1).text, /MEUS CRÉDITOS DE TESTE/i);
assert.equal((await bot.handleConnectivityWebhook(demoWebhook(phones[1], '1'))).type, 'demo_credits_history_sent');
assert.match(sentMessages.at(-1).text, /HISTÓRICO RECENTE/i);
assert.equal((await bot.handleConnectivityWebhook(demoWebhook(phones[1], '2'))).type, 'demo_credits_explanation_sent');
assert.match(sentMessages.at(-1).text, /COMO FUNCIONAM OS CRÉDITOS DE TESTE/i);
const denied = await bot.handleSafeEntryAdminCommand(
  phones[2],
  `admin demo conceder ${phones[3]} 10 tentativa`,
  { replyTo: phones[2] },
);
assert.equal(denied.reason, 'admin_not_authorized');
assert.match(sentMessages.at(-1).text, /não autorizado/i);
assert.equal(botCredits.getBalance(phones[3]).availableBalance, 100);
assert.equal(sentMessages.every(({ text }) => !forbiddenFinancialLanguage.test(text)), true);

console.log('Demo Credits: conta, ledger, idempotência, persistência, fila, mensagens, admin e rollback por flag validados.');
