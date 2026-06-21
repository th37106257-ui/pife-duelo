import { createHmac, randomBytes } from 'node:crypto';
import { calculatePrize } from '../../../src/shared/economy.js';

const VALID_STATUSES = new Set(['pending', 'confirmed', 'rejected', 'expired']);

function nowIso(clock) {
  return new Date(clock()).toISOString();
}

function auditEntry({ action, actor, at, details = null }) {
  return { action, actor, at, details };
}

export function normalizePhone(value) {
  const digits = String(value || '').replace(/\D/g, '');
  return digits.length >= 10 && digits.length <= 15 ? digits : null;
}

export function maskPhone(value) {
  const phone = normalizePhone(value) || '';
  return phone ? `${'*'.repeat(Math.max(4, phone.length - 4))}${phone.slice(-4)}` : '****';
}

export function sanitizePayment(payment) {
  if (!payment) return null;
  const { accessToken, accessTokenHash, ...safe } = payment;
  return structuredClone(safe);
}

export class PaymentService {
  constructor({
    store,
    adminNumbers = [],
    accessSecret,
    publicGameUrl,
    paymentExpiryMinutes = 60,
    accessTtlMinutes = 180,
    clock = Date.now,
    tokenFactory = () => randomBytes(32).toString('base64url'),
  } = {}) {
    this.store = store;
    this.adminNumbers = new Set(adminNumbers.map(normalizePhone).filter(Boolean));
    this.accessSecret = String(accessSecret || '');
    this.publicGameUrl = String(publicGameUrl || '').replace(/\/$/, '');
    this.paymentExpiryMs = Number(paymentExpiryMinutes) * 60 * 1000;
    this.accessTtlMs = Number(accessTtlMinutes) * 60 * 1000;
    this.clock = clock;
    this.tokenFactory = tokenFactory;
  }

  assertConfigured() {
    if (!this.store || !this.accessSecret || !this.publicGameUrl) throw new Error('PAYMENTS_NOT_CONFIGURED');
  }

  isAdmin(phone) {
    return this.adminNumbers.has(normalizePhone(phone));
  }

  assertAdmin(phone) {
    if (!this.isAdmin(phone)) throw new Error('ADMIN_NOT_AUTHORIZED');
  }

  hashToken(token) {
    return createHmac('sha256', this.accessSecret).update(String(token)).digest('hex');
  }

  expirePendingPayments() {
    const cutoff = this.clock() - this.paymentExpiryMs;
    this.store.listPayments()
      .filter((payment) => payment.status === 'pending' && Date.parse(payment.createdAt) < cutoff)
      .forEach((payment) => {
        this.store.updatePayment(payment.paymentId, (current) => {
          const at = nowIso(this.clock);
          return {
            ...current,
            status: 'expired',
            updatedAt: at,
            auditLog: [...current.auditLog, auditEntry({ action: 'payment_expired', actor: 'system', at })],
          };
        });
      });
  }

  listPayments({ status = null } = {}) {
    this.expirePendingPayments();
    return this.store.listPayments()
      .filter((payment) => !status || payment.status === status)
      .sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt))
      .map(sanitizePayment);
  }

  getPayment(paymentId, { includeSecrets = false } = {}) {
    this.expirePendingPayments();
    const payment = this.store.getPayment(paymentId);
    return includeSecrets ? payment : sanitizePayment(payment);
  }

  getActivePaymentForPhone(phone) {
    const normalizedPhone = normalizePhone(phone);
    if (!normalizedPhone) return null;
    this.expirePendingPayments();
    const payment = this.store.listPayments()
      .filter((item) => item.phone === normalizedPhone && item.status === 'pending')
      .sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt))[0];
    return payment ? sanitizePayment(payment) : null;
  }

  selectTable({ phone, selectedTable, source = 'whatsapp' }) {
    this.assertConfigured();
    const normalizedPhone = normalizePhone(phone);
    const economy = calculatePrize(selectedTable);
    if (!normalizedPhone) throw new Error('INVALID_PHONE');
    if (!economy) throw new Error('INVALID_TABLE');

    const existing = this.getActivePaymentForPhone(normalizedPhone);
    if (existing?.receiptReceived) throw new Error('TABLE_LOCKED_AFTER_RECEIPT');
    const at = nowIso(this.clock);

    if (existing) {
      return this.store.updatePayment(existing.paymentId, (current) => ({
        ...current,
        selectedTable: economy.tableValue,
        amount: economy.playerEntry,
        prize: economy.winnerPrize,
        updatedAt: at,
        auditLog: [...current.auditLog, auditEntry({
          action: 'table_selected',
          actor: normalizedPhone,
          at,
          details: { selectedTable: economy.tableValue, source },
        })],
      }));
    }

    const paymentId = this.store.nextPaymentId();
    return this.store.createPayment({
      paymentId,
      phone: normalizedPhone,
      selectedTable: economy.tableValue,
      amount: economy.playerEntry,
      prize: economy.winnerPrize,
      status: 'pending',
      receiptReceived: false,
      confirmedBy: null,
      confirmedAt: null,
      rejectedBy: null,
      rejectedAt: null,
      rejectionReason: null,
      accessTokenHash: null,
      accessExpiresAt: null,
      accessReservedBy: null,
      accessReservedAt: null,
      accessUsedAt: null,
      linkedMatchId: null,
      linkSentAt: null,
      auditLog: [auditEntry({
        action: 'payment_created',
        actor: normalizedPhone,
        at,
        details: { selectedTable: economy.tableValue, source },
      })],
      createdAt: at,
      updatedAt: at,
    });
  }

  markReceiptReceived({ phone, messageId, source = 'whatsapp' }) {
    const normalizedPhone = normalizePhone(phone);
    if (!normalizedPhone) throw new Error('INVALID_PHONE');
    const payment = this.getActivePaymentForPhone(normalizedPhone);
    if (!payment) throw new Error('PAYMENT_NOT_FOUND');
    if (payment.receiptReceived) return payment;

    return this.store.updatePayment(payment.paymentId, (current) => {
      const at = nowIso(this.clock);
      return {
        ...current,
        receiptReceived: true,
        updatedAt: at,
        auditLog: [...current.auditLog, auditEntry({
          action: 'receipt_received',
          actor: normalizedPhone,
          at,
          details: { messageId: messageId || null, source },
        })],
      };
    });
  }

  confirmPayment({ paymentId, adminPhone, source = 'whatsapp' }) {
    this.assertConfigured();
    this.assertAdmin(adminPhone);
    const payment = this.store.getPayment(paymentId);
    if (!payment) throw new Error('PAYMENT_NOT_FOUND');
    if (payment.status !== 'pending') throw new Error('PAYMENT_NOT_PENDING');
    if (!payment.receiptReceived) throw new Error('RECEIPT_REQUIRED');

    const token = this.tokenFactory();
    const at = nowIso(this.clock);
    const accessExpiresAt = new Date(this.clock() + this.accessTtlMs).toISOString();
    const confirmed = this.store.updatePayment(payment.paymentId, (current) => ({
      ...current,
      status: 'confirmed',
      confirmedBy: normalizePhone(adminPhone),
      confirmedAt: at,
      accessTokenHash: this.hashToken(token),
      accessExpiresAt,
      updatedAt: at,
      auditLog: [...current.auditLog, auditEntry({
        action: 'payment_confirmed',
        actor: normalizePhone(adminPhone),
        at,
        details: { source },
      })],
    }));

    return {
      payment: sanitizePayment(confirmed),
      accessLink: `${this.publicGameUrl}/?online=1&access=${encodeURIComponent(token)}`,
    };
  }

  retryAccessLinkDelivery({ paymentId, adminPhone, source = 'whatsapp' }) {
    this.assertConfigured();
    this.assertAdmin(adminPhone);
    const payment = this.store.getPayment(paymentId);
    if (!payment) throw new Error('PAYMENT_NOT_FOUND');
    if (payment.status !== 'confirmed' || payment.linkSentAt || payment.accessUsedAt) {
      throw new Error('PAYMENT_NOT_PENDING');
    }

    const token = this.tokenFactory();
    const at = nowIso(this.clock);
    const accessExpiresAt = new Date(this.clock() + this.accessTtlMs).toISOString();
    const updated = this.store.updatePayment(payment.paymentId, (current) => ({
      ...current,
      accessTokenHash: this.hashToken(token),
      accessExpiresAt,
      updatedAt: at,
      auditLog: [...current.auditLog, auditEntry({
        action: 'access_link_regenerated',
        actor: normalizePhone(adminPhone),
        at,
        details: { source },
      })],
    }));

    return {
      payment: sanitizePayment(updated),
      accessLink: `${this.publicGameUrl}/?online=1&access=${encodeURIComponent(token)}`,
    };
  }

  rejectPayment({ paymentId, adminPhone, reason, source = 'whatsapp' }) {
    this.assertAdmin(adminPhone);
    const payment = this.store.getPayment(paymentId);
    if (!payment) throw new Error('PAYMENT_NOT_FOUND');
    if (payment.status !== 'pending') throw new Error('PAYMENT_NOT_PENDING');
    const safeReason = String(reason || '').trim().slice(0, 180);
    if (!safeReason) throw new Error('REJECTION_REASON_REQUIRED');

    return this.store.updatePayment(payment.paymentId, (current) => {
      const at = nowIso(this.clock);
      return {
        ...current,
        status: 'rejected',
        rejectedBy: normalizePhone(adminPhone),
        rejectedAt: at,
        rejectionReason: safeReason,
        updatedAt: at,
        auditLog: [...current.auditLog, auditEntry({
          action: 'payment_rejected',
          actor: normalizePhone(adminPhone),
          at,
          details: { reason: safeReason, source },
        })],
      };
    });
  }

  markLinkDelivery(paymentId, { sent, error = null } = {}) {
    return this.store.updatePayment(paymentId, (current) => {
      if (current.status !== 'confirmed') throw new Error('PAYMENT_NOT_CONFIRMED');
      const at = nowIso(this.clock);
      return {
        ...current,
        linkSentAt: sent ? at : current.linkSentAt,
        updatedAt: at,
        auditLog: [...current.auditLog, auditEntry({
          action: sent ? 'access_link_sent' : 'access_link_delivery_failed',
          actor: 'system',
          at,
          details: error ? { error: String(error).slice(0, 180) } : null,
        })],
      };
    });
  }

  validateAccessToken(token) {
    if (!token || !this.accessSecret) return null;
    const tokenHash = this.hashToken(token);
    const payment = this.store.listPayments().find((item) => item.accessTokenHash === tokenHash);
    if (!payment || payment.status !== 'confirmed') return null;
    if (payment.accessExpiresAt && Date.parse(payment.accessExpiresAt) <= this.clock()) return null;
    return sanitizePayment(payment);
  }

  reserveAccess({ paymentId, socketId, selectedTable }) {
    return this.store.updatePayment(paymentId, (current) => {
      if (current.status !== 'confirmed') throw new Error('PAYMENT_NOT_CONFIRMED');
      if (current.accessUsedAt) throw new Error('PAYMENT_ACCESS_ALREADY_USED');
      if (Number(selectedTable) !== Number(current.selectedTable)) throw new Error('PAYMENT_TABLE_MISMATCH');
      if (current.accessReservedBy && current.accessReservedBy !== socketId) throw new Error('PAYMENT_ACCESS_RESERVED');
      const at = nowIso(this.clock);
      return {
        ...current,
        accessReservedBy: socketId,
        accessReservedAt: at,
        updatedAt: at,
        auditLog: current.accessReservedBy ? current.auditLog : [...current.auditLog, auditEntry({
          action: 'access_reserved', actor: 'system', at, details: { socketId },
        })],
      };
    });
  }

  releaseAccessReservation({ paymentId, socketId, reason = 'queue_left' }) {
    const payment = this.store.getPayment(paymentId);
    if (!payment || payment.accessUsedAt || payment.accessReservedBy !== socketId) return payment;
    return this.store.updatePayment(paymentId, (current) => {
      const at = nowIso(this.clock);
      return {
        ...current,
        accessReservedBy: null,
        accessReservedAt: null,
        updatedAt: at,
        auditLog: [...current.auditLog, auditEntry({ action: 'access_released', actor: 'system', at, details: { reason } })],
      };
    });
  }

  consumeAccess({ paymentId, socketId, matchId }) {
    return this.store.updatePayment(paymentId, (current) => {
      if (current.status !== 'confirmed') throw new Error('PAYMENT_NOT_CONFIRMED');
      if (current.accessUsedAt) throw new Error('PAYMENT_ACCESS_ALREADY_USED');
      if (current.accessReservedBy !== socketId) throw new Error('PAYMENT_ACCESS_NOT_RESERVED');
      const at = nowIso(this.clock);
      return {
        ...current,
        accessUsedAt: at,
        linkedMatchId: matchId,
        updatedAt: at,
        auditLog: [...current.auditLog, auditEntry({ action: 'access_consumed', actor: 'system', at, details: { matchId } })],
      };
    });
  }

  assertValidStatus(status) {
    return VALID_STATUSES.has(status);
  }
}

export default PaymentService;
