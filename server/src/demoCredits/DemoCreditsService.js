import { randomUUID } from 'node:crypto';
import { calculatePrize } from '../../../src/shared/economy.js';
import {
  DEMO_CREDIT_EVENT_TYPES,
  DEMO_RESERVATION_STATUSES,
  normalizeDemoAmount,
  normalizeDemoPlayerId,
  normalizeDemoReference,
} from './demoCreditTypes.js';

function round(value) {
  return Math.round((Number(value) + Number.EPSILON) * 100) / 100;
}

function nowIso(clock) {
  return new Date(clock()).toISOString();
}

function maskPlayerId(value) {
  const digits = String(value || '').replace(/\D/g, '');
  if (digits.length < 4) return '***';
  return `${digits.slice(0, 4)}****${digits.slice(-4)}`;
}

function maskKey(value) {
  const text = String(value || '');
  return text.length > 22 ? `${text.slice(0, 12)}***${text.slice(-6)}` : text;
}

function createAccount(playerId, at) {
  return {
    playerId,
    availableBalance: 0,
    reservedBalance: 0,
    lifetimeGranted: 0,
    lifetimeConsumed: 0,
    lifetimeRewarded: 0,
    createdAt: at,
    updatedAt: at,
    version: 1,
  };
}

function findEvent(state, idempotencyKey) {
  return state.ledger.find((event) => event.idempotencyKey === idempotencyKey) ?? null;
}

function findReservation(state, playerId, reference) {
  const normalized = normalizeDemoReference(reference);
  return state.reservations.find((reservation) => (
    reservation.playerId === playerId
    && (
      (normalized.entryId && reservation.entryId === normalized.entryId)
      || reservation.publicReference === normalized.publicReference
      || (normalized.matchId && [reservation.matchId, reservation.preMatchId].includes(normalized.matchId))
    )
  )) ?? null;
}

function createEvent({
  playerId,
  type,
  amount,
  previousAccount,
  nextAccount,
  reference,
  reason,
  idempotencyKey,
  actor = 'system',
  clock,
}) {
  return {
    eventId: `DEMO-${randomUUID()}`,
    playerId,
    type,
    amount: round(amount),
    previousAvailableBalance: previousAccount.availableBalance,
    newAvailableBalance: nextAccount.availableBalance,
    previousReservedBalance: previousAccount.reservedBalance,
    newReservedBalance: nextAccount.reservedBalance,
    publicReference: reference?.publicReference ?? null,
    matchId: reference?.matchId ?? null,
    tableId: reference?.tableId ?? null,
    entryId: reference?.entryId ?? null,
    reason: String(reason || '').trim().slice(0, 180) || null,
    actor: String(actor || 'system').slice(0, 80),
    createdAt: nowIso(clock),
    idempotencyKey,
  };
}

export class DemoCreditsService {
  constructor({
    repository,
    enabled = false,
    startingBalance = 100,
    historyLimit = 50,
    maxAdminGrant = 10_000,
    clock = Date.now,
    logInfo = () => {},
    logWarn = () => {},
    logError = () => {},
  } = {}) {
    if (!repository) throw new Error('DEMO_CREDITS_REPOSITORY_REQUIRED');
    this.repository = repository;
    this.enabled = Boolean(enabled);
    this.startingBalance = normalizeDemoAmount(startingBalance);
    this.historyLimit = Math.max(1, Number(historyLimit) || 50);
    this.maxAdminGrant = Math.max(1, Number(maxAdminGrant) || 10_000);
    this.clock = clock;
    this.logInfo = logInfo;
    this.logWarn = logWarn;
    this.logError = logError;
  }

  isEnabled() {
    return this.enabled;
  }

  isPersistenceConfigured() {
    return this.repository.isPersistent();
  }

  assertEnabled() {
    if (!this.enabled) throw new Error('DEMO_CREDITS_DISABLED');
  }

  ensureAccount(state, playerId) {
    const at = nowIso(this.clock);
    const created = !state.accounts[playerId];
    if (created) state.accounts[playerId] = createAccount(playerId, at);
    const idempotencyKey = `demo:initial-grant:${playerId}`;
    let initialGrantApplied = false;
    if (!findEvent(state, idempotencyKey)) {
      const previous = structuredClone(state.accounts[playerId]);
      state.accounts[playerId].availableBalance = round(previous.availableBalance + this.startingBalance);
      state.accounts[playerId].lifetimeGranted = round(previous.lifetimeGranted + this.startingBalance);
      state.accounts[playerId].updatedAt = at;
      state.accounts[playerId].version += 1;
      state.ledger.push(createEvent({
        playerId,
        type: DEMO_CREDIT_EVENT_TYPES.INITIAL_GRANT,
        amount: this.startingBalance,
        previousAccount: previous,
        nextAccount: state.accounts[playerId],
        reference: { publicReference: `DEMO-START-${playerId.slice(-4)}` },
        reason: 'saldo_inicial_de_teste',
        idempotencyKey,
        clock: this.clock,
      }));
      initialGrantApplied = true;
    }
    return { account: state.accounts[playerId], created, initialGrantApplied };
  }

  getOrCreateAccount(playerId) {
    this.assertEnabled();
    const normalizedPlayerId = normalizeDemoPlayerId(playerId);
    const result = this.repository.transaction((state) => this.ensureAccount(state, normalizedPlayerId));
    if (result.created) this.logInfo('DEMO_ACCOUNT_CREATED', { playerId: maskPlayerId(normalizedPlayerId) });
    if (result.initialGrantApplied) {
      this.logInfo('DEMO_INITIAL_CREDITS_GRANTED', {
        playerId: maskPlayerId(normalizedPlayerId),
        amount: this.startingBalance,
      });
    }
    return result;
  }

  grantInitialCredits(playerId) {
    return this.getOrCreateAccount(playerId);
  }

  getBalance(playerId) {
    const result = this.getOrCreateAccount(playerId);
    return {
      enabled: true,
      account: result.account,
      availableBalance: result.account.availableBalance,
      reservedBalance: result.account.reservedBalance,
      totalBalance: round(result.account.availableBalance + result.account.reservedBalance),
      initialGrantApplied: result.initialGrantApplied,
    };
  }

  getHistory(playerId, { limit = this.historyLimit } = {}) {
    this.assertEnabled();
    const normalizedPlayerId = normalizeDemoPlayerId(playerId);
    this.getOrCreateAccount(normalizedPlayerId);
    return this.repository.snapshot().ledger
      .filter((event) => event.playerId === normalizedPlayerId)
      .slice(-Math.min(this.historyLimit, Math.max(1, Number(limit) || this.historyLimit)))
      .reverse();
  }

  reserveCredits(playerId, amount, reference) {
    this.assertEnabled();
    const normalizedPlayerId = normalizeDemoPlayerId(playerId);
    const normalizedAmount = normalizeDemoAmount(amount);
    const normalizedReference = normalizeDemoReference(reference);
    const idempotencyKey = `demo:reserve:${normalizedReference.entryId || normalizedReference.publicReference}:${normalizedPlayerId}`;
    this.logInfo('DEMO_CREDITS_RESERVE_REQUESTED', {
      playerId: maskPlayerId(normalizedPlayerId),
      amount: normalizedAmount,
      reference: normalizedReference.publicReference,
      idempotencyKey: maskKey(idempotencyKey),
    });
    try {
      const result = this.repository.transaction((state) => {
        const ensured = this.ensureAccount(state, normalizedPlayerId);
        const duplicateEvent = findEvent(state, idempotencyKey);
        if (duplicateEvent) {
          return {
            duplicate: true,
            account: ensured.account,
            reservation: findReservation(state, normalizedPlayerId, normalizedReference),
          };
        }
        const activeReservation = state.reservations.find((item) => (
          item.playerId === normalizedPlayerId && item.status === DEMO_RESERVATION_STATUSES.RESERVED
        ));
        if (activeReservation) throw new Error('DEMO_ACTIVE_RESERVATION_EXISTS');
        if (ensured.account.availableBalance < normalizedAmount) {
          const error = new Error('DEMO_INSUFFICIENT_CREDITS');
          error.availableBalance = ensured.account.availableBalance;
          error.requiredAmount = normalizedAmount;
          throw error;
        }
        const previous = structuredClone(ensured.account);
        ensured.account.availableBalance = round(previous.availableBalance - normalizedAmount);
        ensured.account.reservedBalance = round(previous.reservedBalance + normalizedAmount);
        ensured.account.updatedAt = nowIso(this.clock);
        ensured.account.version += 1;
        const reservation = {
          reservationId: `DEMO-RES-${randomUUID()}`,
          playerId: normalizedPlayerId,
          amount: normalizedAmount,
          status: DEMO_RESERVATION_STATUSES.RESERVED,
          publicReference: normalizedReference.publicReference,
          entryId: normalizedReference.entryId,
          preMatchId: normalizedReference.matchId,
          matchId: null,
          tableId: normalizedReference.tableId,
          createdAt: nowIso(this.clock),
          updatedAt: nowIso(this.clock),
        };
        state.reservations.push(reservation);
        state.ledger.push(createEvent({
          playerId: normalizedPlayerId,
          type: DEMO_CREDIT_EVENT_TYPES.ENTRY_RESERVED,
          amount: normalizedAmount,
          previousAccount: previous,
          nextAccount: ensured.account,
          reference: normalizedReference,
          reason: 'entrada_demo_reservada',
          idempotencyKey,
          clock: this.clock,
        }));
        return { duplicate: false, account: ensured.account, reservation, initialGrantApplied: ensured.initialGrantApplied };
      });
      if (result.duplicate) this.logInfo('DEMO_OPERATION_DUPLICATE_IGNORED', { idempotencyKey: maskKey(idempotencyKey) });
      else this.logInfo('DEMO_CREDITS_RESERVED', {
        playerId: maskPlayerId(normalizedPlayerId),
        amount: normalizedAmount,
        reference: normalizedReference.publicReference,
        availableBalance: result.account.availableBalance,
        reservedBalance: result.account.reservedBalance,
      });
      return result;
    } catch (error) {
      this.logWarn('DEMO_CREDITS_RESERVE_FAILED', {
        playerId: maskPlayerId(normalizedPlayerId),
        amount: normalizedAmount,
        reference: normalizedReference.publicReference,
        reason: error.message,
      });
      throw error;
    }
  }

  releaseReservation(playerId, reference, reason = 'entrada_demo_cancelada') {
    this.assertEnabled();
    const normalizedPlayerId = normalizeDemoPlayerId(playerId);
    const normalizedReference = normalizeDemoReference(reference);
    const idempotencyKey = `demo:release:${normalizedReference.entryId || normalizedReference.publicReference}:${normalizedPlayerId}`;
    const result = this.repository.transaction((state) => {
      const account = state.accounts[normalizedPlayerId];
      const reservation = findReservation(state, normalizedPlayerId, normalizedReference);
      if (!account || !reservation) return { released: false, reason: 'DEMO_RESERVATION_NOT_FOUND' };
      if (findEvent(state, idempotencyKey) || reservation.status === DEMO_RESERVATION_STATUSES.RELEASED) {
        return { released: false, duplicate: true, account, reservation };
      }
      if (reservation.status !== DEMO_RESERVATION_STATUSES.RESERVED) {
        return { released: false, reason: 'DEMO_RESERVATION_NOT_RELEASEABLE', account, reservation };
      }
      const previous = structuredClone(account);
      account.availableBalance = round(previous.availableBalance + reservation.amount);
      account.reservedBalance = round(previous.reservedBalance - reservation.amount);
      account.updatedAt = nowIso(this.clock);
      account.version += 1;
      reservation.status = DEMO_RESERVATION_STATUSES.RELEASED;
      reservation.releaseReason = String(reason).slice(0, 180);
      reservation.updatedAt = nowIso(this.clock);
      state.ledger.push(createEvent({
        playerId: normalizedPlayerId,
        type: DEMO_CREDIT_EVENT_TYPES.ENTRY_RELEASED,
        amount: reservation.amount,
        previousAccount: previous,
        nextAccount: account,
        reference: {
          ...normalizedReference,
          matchId: reservation.matchId || reservation.preMatchId || normalizedReference.matchId,
          tableId: reservation.tableId,
        },
        reason,
        idempotencyKey,
        clock: this.clock,
      }));
      return { released: true, account, reservation };
    });
    if (result.duplicate) this.logInfo('DEMO_OPERATION_DUPLICATE_IGNORED', { idempotencyKey: maskKey(idempotencyKey) });
    if (result.released) this.logInfo('DEMO_CREDITS_RELEASED', {
      playerId: maskPlayerId(normalizedPlayerId),
      amount: result.reservation.amount,
      reference: result.reservation.publicReference,
      reason,
    });
    return result;
  }

  validateMatchReservations(participants, tableId) {
    this.assertEnabled();
    const state = this.repository.snapshot();
    const normalizedTable = Number(tableId);
    const normalizedParticipants = participants.map((item) => ({
      playerId: normalizeDemoPlayerId(item.playerId),
      entryId: String(item.entryId || '').trim(),
    }));
    if (normalizedParticipants.length !== 2 || new Set(normalizedParticipants.map((item) => item.playerId)).size !== 2) {
      throw new Error('DEMO_MATCH_PARTICIPANTS_INVALID');
    }
    return normalizedParticipants.map((participant) => {
      const reservation = state.reservations.find((item) => (
        item.playerId === participant.playerId
        && item.entryId === participant.entryId
        && item.status === DEMO_RESERVATION_STATUSES.RESERVED
      ));
      if (!reservation) throw new Error('DEMO_MATCH_RESERVATION_INVALID');
      if (Number(reservation.tableId) !== normalizedTable) throw new Error('DEMO_MATCH_TABLE_MISMATCH');
      return structuredClone(reservation);
    });
  }

  consumeMatchReservations(participants, { matchId, tableId } = {}) {
    this.assertEnabled();
    const safeMatchId = String(matchId || '').trim();
    if (!safeMatchId) throw new Error('DEMO_MATCH_ID_REQUIRED');
    const normalizedParticipants = participants.map((item) => ({
      playerId: normalizeDemoPlayerId(item.playerId),
      entryId: String(item.entryId || '').trim(),
      matchPlayerId: String(item.matchPlayerId || '').trim() || null,
    }));
    const preflightState = this.repository.snapshot();
    const preflightKeys = normalizedParticipants.map((participant) => `demo:consume:${safeMatchId}:${participant.playerId}`);
    if (preflightKeys.every((key) => Boolean(findEvent(preflightState, key)))) {
      this.logInfo('DEMO_OPERATION_DUPLICATE_IGNORED', { matchId: safeMatchId, operation: 'consume' });
      return { duplicate: true, operations: [] };
    }
    this.validateMatchReservations(normalizedParticipants, tableId);
    const result = this.repository.transaction((state) => {
      const operations = normalizedParticipants.map((participant) => {
        const reservation = state.reservations.find((item) => item.playerId === participant.playerId && item.entryId === participant.entryId);
        const idempotencyKey = `demo:consume:${safeMatchId}:${participant.playerId}`;
        return { participant, reservation, account: state.accounts[participant.playerId], idempotencyKey };
      });
      const allDuplicate = operations.every(({ idempotencyKey }) => Boolean(findEvent(state, idempotencyKey)));
      if (allDuplicate) return { duplicate: true, operations: [] };
      if (operations.some(({ reservation, account, idempotencyKey }) => (
        !reservation || !account || reservation.status !== DEMO_RESERVATION_STATUSES.RESERVED || findEvent(state, idempotencyKey)
      ))) throw new Error('DEMO_MATCH_RESERVATION_INVALID');
      const completed = operations.map(({ participant, reservation, account, idempotencyKey }) => {
        const previous = structuredClone(account);
        account.reservedBalance = round(previous.reservedBalance - reservation.amount);
        account.lifetimeConsumed = round(previous.lifetimeConsumed + reservation.amount);
        account.updatedAt = nowIso(this.clock);
        account.version += 1;
        reservation.status = DEMO_RESERVATION_STATUSES.CONSUMED;
        reservation.matchId = safeMatchId;
        reservation.matchPlayerId = participant.matchPlayerId;
        reservation.updatedAt = nowIso(this.clock);
        state.ledger.push(createEvent({
          playerId: participant.playerId,
          type: DEMO_CREDIT_EVENT_TYPES.ENTRY_CONSUMED,
          amount: reservation.amount,
          previousAccount: previous,
          nextAccount: account,
          reference: {
            publicReference: reservation.publicReference,
            entryId: reservation.entryId,
            matchId: safeMatchId,
            tableId: reservation.tableId,
          },
          reason: 'match_started',
          idempotencyKey,
          clock: this.clock,
        }));
        return { playerId: participant.playerId, account, reservation };
      });
      return { duplicate: false, operations: completed };
    });
    if (result.duplicate) this.logInfo('DEMO_OPERATION_DUPLICATE_IGNORED', { matchId: safeMatchId, operation: 'consume' });
    else result.operations.forEach((item) => this.logInfo('DEMO_CREDITS_CONSUMED', {
      playerId: maskPlayerId(item.playerId),
      matchId: safeMatchId,
      amount: item.reservation.amount,
      tableId: item.reservation.tableId,
    }));
    return result;
  }

  rewardWinner(playerId, amount, reference) {
    this.assertEnabled();
    const normalizedPlayerId = normalizeDemoPlayerId(playerId);
    const normalizedAmount = normalizeDemoAmount(amount);
    const normalizedReference = normalizeDemoReference(reference);
    const idempotencyKey = `demo:reward:${normalizedReference.matchId || normalizedReference.publicReference}:${normalizedPlayerId}`;
    const result = this.repository.transaction((state) => {
      const account = state.accounts[normalizedPlayerId];
      if (!account) throw new Error('DEMO_ACCOUNT_NOT_FOUND');
      if (findEvent(state, idempotencyKey)) return { duplicate: true, account };
      const consumedReservation = state.reservations.find((item) => (
        item.playerId === normalizedPlayerId
        && item.status === DEMO_RESERVATION_STATUSES.CONSUMED
        && item.matchId === normalizedReference.matchId
        && (!normalizedReference.entryId || item.entryId === normalizedReference.entryId)
      ));
      if (!consumedReservation) throw new Error('DEMO_MATCH_REWARD_NOT_AUTHORIZED');
      const previous = structuredClone(account);
      account.availableBalance = round(previous.availableBalance + normalizedAmount);
      account.lifetimeRewarded = round(previous.lifetimeRewarded + normalizedAmount);
      account.updatedAt = nowIso(this.clock);
      account.version += 1;
      state.ledger.push(createEvent({
        playerId: normalizedPlayerId,
        type: DEMO_CREDIT_EVENT_TYPES.MATCH_REWARD,
        amount: normalizedAmount,
        previousAccount: previous,
        nextAccount: account,
        reference: normalizedReference,
        reason: 'vitoria_demo_confirmada',
        idempotencyKey,
        clock: this.clock,
      }));
      return { duplicate: false, account };
    });
    if (result.duplicate) this.logInfo('DEMO_OPERATION_DUPLICATE_IGNORED', { idempotencyKey: maskKey(idempotencyKey) });
    else this.logInfo('DEMO_MATCH_REWARD_GRANTED', {
      playerId: maskPlayerId(normalizedPlayerId),
      matchId: normalizedReference.matchId,
      amount: normalizedAmount,
      availableBalance: result.account.availableBalance,
    });
    return result;
  }

  compensateMatch(participants, { matchId, reason = 'SYSTEM_ABORT' } = {}) {
    this.assertEnabled();
    const safeMatchId = String(matchId || '').trim();
    if (!safeMatchId) throw new Error('DEMO_MATCH_ID_REQUIRED');
    const normalizedParticipants = participants.map((participant) => ({
      playerId: normalizeDemoPlayerId(participant.playerId),
      entryId: String(participant.entryId || '').trim(),
    }));
    const results = this.repository.transaction((state) => normalizedParticipants.flatMap((participant) => {
      const reservation = state.reservations.find((item) => (
        item.playerId === participant.playerId
        && item.status === DEMO_RESERVATION_STATUSES.CONSUMED
        && item.matchId === safeMatchId
        && (!participant.entryId || item.entryId === participant.entryId)
      ));
      if (!reservation) {
        const duplicate = findEvent(state, `demo:compensate:${safeMatchId}:${participant.playerId}`);
        return duplicate ? [{ playerId: participant.playerId, duplicate: true, account: state.accounts[participant.playerId] }] : [];
      }
      const playerId = participant.playerId;
      const idempotencyKey = `demo:compensate:${safeMatchId}:${playerId}`;
      const account = state.accounts[playerId];
      const current = reservation;
      if (findEvent(state, idempotencyKey) || current.status === DEMO_RESERVATION_STATUSES.COMPENSATED) {
        return [{ playerId, duplicate: true, account }];
      }
      const previous = structuredClone(account);
      account.availableBalance = round(previous.availableBalance + current.amount);
      account.updatedAt = nowIso(this.clock);
      account.version += 1;
      current.status = DEMO_RESERVATION_STATUSES.COMPENSATED;
      current.updatedAt = nowIso(this.clock);
      state.ledger.push(createEvent({
        playerId,
        type: DEMO_CREDIT_EVENT_TYPES.SYSTEM_COMPENSATION,
        amount: current.amount,
        previousAccount: previous,
        nextAccount: account,
        reference: {
          publicReference: current.publicReference,
          entryId: current.entryId,
          matchId: safeMatchId,
          tableId: current.tableId,
        },
        reason,
        idempotencyKey,
        clock: this.clock,
      }));
      return [{ playerId, duplicate: false, account, amount: current.amount }];
    }));
    for (const result of results) {
      if (!result.duplicate) this.logInfo('DEMO_SYSTEM_COMPENSATION_GRANTED', {
        playerId: maskPlayerId(result.playerId),
        matchId: safeMatchId,
        amount: result.amount,
        reason,
      });
    }
    return results;
  }

  settleMatchResult({ matchId, tableId, winnerMatchPlayerId = null, reason = 'match_finished', participants = [] } = {}) {
    this.assertEnabled();
    const safeMatchId = String(matchId || '').trim();
    const normalizedReason = String(reason || '').toLowerCase();
    const mappedParticipants = participants.map((item) => ({
      playerId: normalizeDemoPlayerId(item.playerId),
      entryId: String(item.entryId || '').trim(),
      matchPlayerId: String(item.matchPlayerId || '').trim() || null,
    }));
    if (normalizedReason.includes('system_abort')) {
      return { compensated: this.compensateMatch(mappedParticipants, { matchId: safeMatchId, reason }), rewarded: null };
    }
    const winner = mappedParticipants.find((item) => item.matchPlayerId === winnerMatchPlayerId) ?? null;
    if (!winner) {
      return {
        compensated: this.compensateMatch(mappedParticipants, { matchId: safeMatchId, reason: reason || 'winner_not_mapped' }),
        rewarded: null,
        reason: 'winner_not_mapped',
      };
    }
    const economy = calculatePrize(tableId);
    if (!economy) throw new Error('DEMO_INVALID_TABLE');
    const rewarded = this.rewardWinner(winner.playerId, economy.winnerPrize, {
      publicReference: `DEMO-MATCH-${safeMatchId.slice(-8)}`,
      matchId: safeMatchId,
      tableId: Number(tableId),
      entryId: winner.entryId,
    });
    return { compensated: [], rewarded, rewardAmount: economy.winnerPrize, winnerPlayerId: winner.playerId };
  }

  adminGrantCredits(playerId, amount, reason, actor = 'admin') {
    this.assertEnabled();
    const normalizedPlayerId = normalizeDemoPlayerId(playerId);
    const normalizedAmount = normalizeDemoAmount(amount, { integer: true });
    if (normalizedAmount > this.maxAdminGrant) throw new Error('DEMO_ADMIN_GRANT_LIMIT_EXCEEDED');
    const safeReason = String(reason || '').trim().slice(0, 180);
    if (!safeReason) throw new Error('DEMO_ADMIN_REASON_REQUIRED');
    const idempotencyKey = `demo:admin-grant:${randomUUID()}`;
    const result = this.repository.transaction((state) => {
      const ensured = this.ensureAccount(state, normalizedPlayerId);
      const previous = structuredClone(ensured.account);
      ensured.account.availableBalance = round(previous.availableBalance + normalizedAmount);
      ensured.account.lifetimeGranted = round(previous.lifetimeGranted + normalizedAmount);
      ensured.account.updatedAt = nowIso(this.clock);
      ensured.account.version += 1;
      const publicReference = `DEMO-${randomUUID().slice(0, 8).toUpperCase()}`;
      state.ledger.push(createEvent({
        playerId: normalizedPlayerId,
        type: DEMO_CREDIT_EVENT_TYPES.ADMIN_GRANT,
        amount: normalizedAmount,
        previousAccount: previous,
        nextAccount: ensured.account,
        reference: { publicReference },
        reason: safeReason,
        idempotencyKey,
        actor,
        clock: this.clock,
      }));
      return { account: ensured.account, previousBalance: previous.availableBalance, publicReference };
    });
    this.logInfo('DEMO_ADMIN_GRANT', {
      playerId: maskPlayerId(normalizedPlayerId),
      amount: normalizedAmount,
      actor: maskPlayerId(actor),
      reference: result.publicReference,
    });
    return result;
  }

  adminResetDemoAccount(playerId, reason, actor = 'admin') {
    this.assertEnabled();
    const normalizedPlayerId = normalizeDemoPlayerId(playerId);
    const safeReason = String(reason || '').trim().slice(0, 180);
    if (!safeReason) throw new Error('DEMO_ADMIN_REASON_REQUIRED');
    const result = this.repository.transaction((state) => {
      const ensured = this.ensureAccount(state, normalizedPlayerId);
      if (ensured.account.reservedBalance > 0) throw new Error('DEMO_ACCOUNT_HAS_ACTIVE_RESERVATION');
      const previous = structuredClone(ensured.account);
      ensured.account.availableBalance = this.startingBalance;
      ensured.account.updatedAt = nowIso(this.clock);
      ensured.account.version += 1;
      const idempotencyKey = `demo:account-reset:${randomUUID()}`;
      const publicReference = `DEMO-RESET-${randomUUID().slice(0, 8).toUpperCase()}`;
      state.ledger.push(createEvent({
        playerId: normalizedPlayerId,
        type: DEMO_CREDIT_EVENT_TYPES.ACCOUNT_RESET,
        amount: round(this.startingBalance - previous.availableBalance),
        previousAccount: previous,
        nextAccount: ensured.account,
        reference: { publicReference },
        reason: safeReason,
        idempotencyKey,
        actor,
        clock: this.clock,
      }));
      return { account: ensured.account, previousBalance: previous.availableBalance, publicReference };
    });
    this.logInfo('DEMO_ACCOUNT_RESET', {
      playerId: maskPlayerId(normalizedPlayerId),
      actor: maskPlayerId(actor),
      reference: result.publicReference,
    });
    return result;
  }

  getStatus() {
    const snapshot = this.repository.snapshot();
    return {
      enabled: this.enabled,
      startingBalance: this.startingBalance,
      persistenceConfigured: this.isPersistenceConfigured(),
      accountCount: Object.keys(snapshot.accounts).length,
      activeReservations: snapshot.reservations.filter((item) => item.status === DEMO_RESERVATION_STATUSES.RESERVED).length,
      ledgerEvents: snapshot.ledger.length,
    };
  }
}

export default DemoCreditsService;
