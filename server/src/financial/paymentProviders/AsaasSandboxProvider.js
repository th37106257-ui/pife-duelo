import { timingSafeEqual } from 'node:crypto';
import { PaymentProvider } from './PaymentProvider.js';

function secureEquals(left, right) {
  const a = Buffer.from(String(left || ''));
  const b = Buffer.from(String(right || ''));
  return a.length === b.length && a.length > 0 && timingSafeEqual(a, b);
}

export class AsaasSandboxProvider extends PaymentProvider {
  constructor({ apiKey, webhookToken, baseUrl = 'https://api-sandbox.asaas.com/v3', fetchImpl = fetch } = {}) {
    super();
    if (!String(apiKey || '').startsWith('$aact_hmlg_')) throw new Error('ASAAS_SANDBOX_KEY_REQUIRED');
    this.apiKey = apiKey;
    this.webhookToken = String(webhookToken || '');
    this.baseUrl = String(baseUrl).replace(/\/$/, '');
    if (this.baseUrl !== 'https://api-sandbox.asaas.com/v3') throw new Error('ASAAS_SANDBOX_URL_REQUIRED');
    this.fetchImpl = fetchImpl;
  }

  async request(path, { method = 'GET', body = null } = {}) {
    const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
      method,
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'PifeDuelo/1.0 (Node.js; sandbox)',
        access_token: this.apiKey,
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = new Error(`ASAAS_REQUEST_FAILED:${response.status}`);
      error.status = response.status;
      error.details = payload?.errors?.map((item) => item.code).filter(Boolean) ?? [];
      throw error;
    }
    return payload;
  }

  async createOrFindCustomer({ publicId, name, phone, existingCustomerId = null }) {
    if (existingCustomerId) return { id: existingCustomerId, existing: true };
    const created = await this.request('/customers', {
      method: 'POST',
      body: { name, mobilePhone: phone, externalReference: publicId, notificationDisabled: true },
    });
    return { ...created, existing: false };
  }

  async createPixCharge({ customerId, amountCents, dueDate, description, externalReference }) {
    return this.request('/payments', {
      method: 'POST',
      body: {
        customer: customerId,
        billingType: 'PIX',
        value: Number(amountCents) / 100,
        dueDate,
        description,
        externalReference,
      },
    });
  }

  getPixQrCode(paymentId) {
    return this.request(`/payments/${encodeURIComponent(paymentId)}/pixQrCode`);
  }

  getPayment(paymentId) {
    return this.request(`/payments/${encodeURIComponent(paymentId)}`);
  }

  validateWebhook({ headers }) {
    return secureEquals(headers?.['asaas-access-token'], this.webhookToken);
  }

  async getProviderBalance() {
    const balance = await this.request('/finance/balance');
    return { amountCents: Math.round(Number(balance.balance || 0) * 100) };
  }
}

export default AsaasSandboxProvider;
