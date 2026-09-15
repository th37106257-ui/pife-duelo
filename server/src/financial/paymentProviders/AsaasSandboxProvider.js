import { timingSafeEqual } from 'node:crypto';
import { PaymentProvider } from './PaymentProvider.js';

function secureEquals(left, right) {
  const a = Buffer.from(String(left || ''));
  const b = Buffer.from(String(right || ''));
  return a.length === b.length && a.length > 0 && timingSafeEqual(a, b);
}

export class AsaasSandboxProvider extends PaymentProvider {
  constructor({ apiKey, webhookToken, baseUrl = 'https://api-sandbox.asaas.com/v3', fetchImpl = fetch, timeoutMs = 10000 } = {}) {
    super();
    if (!String(apiKey || '').startsWith('$aact_hmlg_')) throw new Error('ASAAS_SANDBOX_KEY_REQUIRED');
    this.apiKey = apiKey;
    this.webhookToken = String(webhookToken || '');
    this.baseUrl = String(baseUrl).replace(/\/$/, '');
    if (this.baseUrl !== 'https://api-sandbox.asaas.com/v3') throw new Error('ASAAS_SANDBOX_URL_REQUIRED');
    this.fetchImpl = fetchImpl;
    this.timeoutMs = timeoutMs;
  }

  async request(path, { method = 'GET', body = null } = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method,
        signal: controller.signal,
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': 'PifeDuelo/1.0 (Node.js; sandbox)',
          access_token: this.apiKey,
        },
        body: body ? JSON.stringify(body) : undefined,
      });
      const payload = await response.json().catch(() => { throw new Error('ASAAS_INVALID_JSON'); });
      if (!response.ok) {
        const error = new Error(`ASAAS_REQUEST_FAILED:${response.status}`);
        error.status = response.status;
        error.details = payload?.errors?.map((item) => item.code).filter(Boolean) ?? [];
        throw error;
      }
      return payload;
    } catch (error) {
      if (controller.signal.aborted) throw new Error('ASAAS_REQUEST_TIMEOUT');
      if (/^ASAAS_(REQUEST_FAILED:\d{3}|INVALID_JSON)$/.test(error?.message || '')) throw error;
      throw new Error('ASAAS_NETWORK_ERROR');
    } finally {
      clearTimeout(timer);
    }
  }

  async createOrFindCustomer({ publicId, name, phone, existingCustomerId = null }) {
    if (existingCustomerId) return { id: existingCustomerId, existing: true };
    const existing = await this.findCustomerByExternalReference(publicId);
    if (existing) return { ...existing, existing: true };
    const created = await this.request('/customers', {
      method: 'POST',
      body: { name, mobilePhone: phone, externalReference: publicId, notificationDisabled: true },
    });
    return { ...created, existing: false };
  }

  async findCustomerByExternalReference(publicId) {
    const result = await this.request(`/customers?externalReference=${encodeURIComponent(publicId)}&limit=1`);
    return Array.isArray(result?.data) ? (result.data[0] ?? null) : null;
  }

  async findPixChargeByExternalReference(externalReference) {
    const result = await this.request(`/payments?externalReference=${encodeURIComponent(externalReference)}&limit=1`);
    return Array.isArray(result?.data) ? (result.data[0] ?? null) : null;
  }

  async createPixCharge({ customerId, amountCents, dueDate, description, externalReference }) {
    const existing = await this.findPixChargeByExternalReference(externalReference);
    if (existing) return { ...existing, existing: true };
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
    return this.request(`/payments/${encodeURIComponent(paymentId)}`).then((payment) => {
      const amountCents = Math.round(Number(payment.value || 0) * 100);
      const hasNet = payment.netValue !== undefined && payment.netValue !== null;
      const netAmountCents = hasNet ? Math.round(Number(payment.netValue) * 100) : null;
      return {
        ...payment,
        amountCents,
        netAmountCents,
        feeAmountCents: hasNet ? Math.max(0, amountCents - netAmountCents) : null,
      };
    });
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
