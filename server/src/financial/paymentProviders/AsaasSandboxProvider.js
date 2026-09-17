import { timingSafeEqual } from 'node:crypto';
import { PaymentProvider } from './PaymentProvider.js';

function secureEquals(left, right) {
  const a = Buffer.from(String(left || ''));
  const b = Buffer.from(String(right || ''));
  return a.length === b.length && a.length > 0 && timingSafeEqual(a, b);
}

function normalizeSandboxDocument(value) {
  const raw = String(value || '').trim();
  if (!raw) throw new Error('ASAAS_SANDBOX_CUSTOMER_DOCUMENT_REQUIRED');
  const normalized = raw.replace(/[.\-/\s]/g, '');
  if (!/^(?:\d{11}|\d{14})$/.test(normalized)) {
    throw new Error('ASAAS_SANDBOX_CUSTOMER_DOCUMENT_INVALID');
  }
  return normalized;
}

function sanitizeProviderErrorCode(value) {
  return String(value || '').replace(/[^a-zA-Z0-9_.-]/g, '').slice(0, 80) || null;
}

function sanitizeProviderErrorDescription(value) {
  return String(value || '')
    .replace(/\$aact_[^\s"']+/gi, '[REDACTED]')
    .replace(/\b\d{2}\.?\d{3}\.?\d{3}\/?\d{4}-?\d{2}\b/g, '[REDACTED]')
    .replace(/\b\d{3}\.?\d{3}\.?\d{3}-?\d{2}\b/g, '[REDACTED]')
    .replace(/\b(?:\+?55[\s.-]?)?(?:\(?\d{2}\)?[\s.-]?)?\d{4,5}[\s.-]?\d{4}\b/g, '[REDACTED]')
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, '[REDACTED]')
    .trim()
    .slice(0, 240);
}

export class AsaasSandboxProvider extends PaymentProvider {
  constructor({
    apiKey,
    webhookToken,
    sandboxTestCpfCnpj = '',
    baseUrl = 'https://api-sandbox.asaas.com/v3',
    fetchImpl = fetch,
    timeoutMs = 10000,
  } = {}) {
    super();
    if (!String(apiKey || '').startsWith('$aact_hmlg_')) throw new Error('ASAAS_SANDBOX_KEY_REQUIRED');
    this.apiKey = apiKey;
    this.webhookToken = String(webhookToken || '');
    this.sandboxTestCpfCnpj = String(sandboxTestCpfCnpj || '');
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
        const providerErrors = Array.isArray(payload?.errors) ? payload.errors : [];
        error.details = providerErrors.map((item) => ({
          code: sanitizeProviderErrorCode(item?.code),
          description: sanitizeProviderErrorDescription(item?.description),
        })).filter((item) => item.code || item.description);
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
    if (existing) {
      if (existing.cpfCnpj) return { ...existing, existing: true };
      const updated = await this.request(`/customers/${encodeURIComponent(existing.id)}`, {
        method: 'PUT',
        body: { cpfCnpj: normalizeSandboxDocument(this.sandboxTestCpfCnpj) },
      });
      return { ...existing, ...updated, id: existing.id, existing: true };
    }
    const created = await this.request('/customers', {
      method: 'POST',
      body: {
        name,
        mobilePhone: phone,
        cpfCnpj: normalizeSandboxDocument(this.sandboxTestCpfCnpj),
        externalReference: publicId,
        notificationDisabled: true,
      },
    });
    return { ...created, existing: false };
  }

  async findCustomerByExternalReference(publicId) {
    const result = await this.request(`/customers?externalReference=${encodeURIComponent(publicId)}&limit=2`);
    const matches = Array.isArray(result?.data)
      ? result.data.filter((item) => item?.externalReference === publicId)
      : [];
    const total = Number(result?.totalCount ?? matches.length);
    if (total > 1 || matches.length > 1) throw new Error('ASAAS_CUSTOMER_NOT_UNIQUE');
    return matches[0] ?? null;
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
