import { createHash } from 'node:crypto';
import { PaymentProvider } from './PaymentProvider.js';

function stableId(prefix, value) {
  return `${prefix}_${createHash('sha256').update(String(value)).digest('hex').slice(0, 20)}`;
}

export class MockPaymentProvider extends PaymentProvider {
  constructor({ webhookToken = 'mock-webhook-token' } = {}) {
    super();
    this.webhookToken = webhookToken;
    this.payments = new Map();
  }

  async createOrFindCustomer({ publicId }) {
    return { id: stableId('cus_mock', publicId), existing: true };
  }

  async createPixCharge({ customerId, amountCents, dueDate, description, externalReference }) {
    const id = stableId('pay_mock', externalReference);
    const payment = { id, customer: customerId, amountCents, dueDate, description, externalReference, status: 'PENDING' };
    this.payments.set(id, payment);
    return payment;
  }

  async getPixQrCode(paymentId) {
    if (!this.payments.has(paymentId)) throw new Error('MOCK_PAYMENT_NOT_FOUND');
    return { encodedImage: `MOCK_QR_${paymentId}`, payload: `000201-MOCK-${paymentId}`, expirationDate: null };
  }

  async getPayment(paymentId) {
    const payment = this.payments.get(paymentId);
    if (!payment) throw new Error('MOCK_PAYMENT_NOT_FOUND');
    return payment;
  }

  validateWebhook({ headers }) {
    return String(headers?.['asaas-access-token'] || '') === this.webhookToken;
  }

  markPaid(paymentId) {
    const payment = this.payments.get(paymentId);
    if (!payment) throw new Error('MOCK_PAYMENT_NOT_FOUND');
    payment.status = 'RECEIVED';
    return payment;
  }

  markRefunded(paymentId) {
    const payment = this.payments.get(paymentId);
    if (!payment) throw new Error('MOCK_PAYMENT_NOT_FOUND');
    payment.status = 'REFUNDED';
    return payment;
  }

  async getProviderBalance() {
    return { amountCents: [...this.payments.values()]
      .filter((payment) => payment.status === 'RECEIVED')
      .reduce((sum, payment) => sum + payment.amountCents, 0) };
  }
}

export default MockPaymentProvider;
