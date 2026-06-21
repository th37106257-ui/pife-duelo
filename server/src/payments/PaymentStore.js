import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

function createEmptyState() {
  return {
    version: 1,
    nextPaymentNumber: 1000,
    payments: [],
    processedMessageIds: [],
  };
}

export class PaymentStore {
  constructor({ filePath = null, initialState = null } = {}) {
    this.filePath = filePath;
    this.state = initialState ? structuredClone(initialState) : this.load();
  }

  load() {
    if (!this.filePath || !existsSync(this.filePath)) return createEmptyState();
    try {
      const parsed = JSON.parse(readFileSync(this.filePath, 'utf8'));
      return {
        ...createEmptyState(),
        ...parsed,
        payments: Array.isArray(parsed.payments) ? parsed.payments : [],
        processedMessageIds: Array.isArray(parsed.processedMessageIds) ? parsed.processedMessageIds : [],
      };
    } catch (error) {
      throw new Error(`PAYMENT_STORE_INVALID: ${error.message}`);
    }
  }

  persist() {
    if (!this.filePath) return;
    mkdirSync(dirname(this.filePath), { recursive: true });
    const temporaryPath = `${this.filePath}.tmp`;
    writeFileSync(temporaryPath, JSON.stringify(this.state, null, 2), { encoding: 'utf8', mode: 0o600 });
    renameSync(temporaryPath, this.filePath);
  }

  nextPaymentId() {
    const paymentId = String(this.state.nextPaymentNumber);
    this.state.nextPaymentNumber += 1;
    this.persist();
    return paymentId;
  }

  listPayments() {
    return structuredClone(this.state.payments);
  }

  getPayment(paymentId) {
    const payment = this.state.payments.find((item) => item.paymentId === String(paymentId));
    return payment ? structuredClone(payment) : null;
  }

  createPayment(payment) {
    if (this.state.payments.some((item) => item.paymentId === payment.paymentId)) {
      throw new Error('PAYMENT_ID_ALREADY_EXISTS');
    }
    this.state.payments.push(structuredClone(payment));
    this.persist();
    return structuredClone(payment);
  }

  updatePayment(paymentId, updater) {
    const index = this.state.payments.findIndex((item) => item.paymentId === String(paymentId));
    if (index < 0) throw new Error('PAYMENT_NOT_FOUND');
    const current = structuredClone(this.state.payments[index]);
    const next = updater(current);
    this.state.payments[index] = structuredClone(next);
    this.persist();
    return structuredClone(next);
  }

  hasProcessedMessage(messageId) {
    return this.state.processedMessageIds.includes(String(messageId));
  }

  markMessageProcessed(messageId) {
    const normalized = String(messageId || '').trim();
    if (!normalized || this.hasProcessedMessage(normalized)) return false;
    this.state.processedMessageIds.push(normalized);
    this.state.processedMessageIds = this.state.processedMessageIds.slice(-1000);
    this.persist();
    return true;
  }
}

export default PaymentStore;
