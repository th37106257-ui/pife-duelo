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
    this.customers = new Map();
  }

  async createOrFindCustomer({ publicId }) {
    const existing = await this.findCustomerByExternalReference(publicId);
    if (existing) return { ...existing, existing: true };
    const customer = { id: stableId('cus_mock', publicId), externalReference: publicId };
    this.customers.set(publicId, customer);
    return { ...customer, existing: false };
  }

  async findCustomerByExternalReference(publicId) {
    return this.customers.get(String(publicId)) ?? null;
  }

  async findPixChargeByExternalReference(externalReference) {
    return [...this.payments.values()].find((payment) => payment.externalReference === externalReference) ?? null;
  }

  async createPixCharge({ customerId, amountCents, dueDate, description, externalReference }) {
    const existing = await this.findPixChargeByExternalReference(externalReference);
    if (existing) return { ...existing, existing: true };
    const id = stableId('pay_mock', externalReference);
    const payment = {
      id, customer: customerId, amountCents, netAmountCents: amountCents, feeAmountCents: 0,
      dueDate, description, externalReference, status: 'PENDING',
    };
    this.payments.set(id, payment);
    return { ...payment, existing: false };
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

  async cancelPayment(paymentId) {
    const payment = await this.getPayment(paymentId);
    if (payment.status === 'RECEIVED') return payment;
    payment.status = 'CANCELLED';
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
      .reduce((sum, payment) => sum + (payment.netAmountCents ?? payment.amountCents), 0) };
  }
}

export default MockPaymentProvider;
