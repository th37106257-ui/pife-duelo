import { normalizePhone } from './PaymentService.js';

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function maskTechnicalIdentity(value) {
  const raw = String(value || '').trim();
  if (!raw) return null;
  const [id, suffix] = raw.split('@');
  const digits = id.replace(/\D/g, '');
  if (digits.length >= 4) {
    const masked = `${'*'.repeat(Math.max(4, digits.length - 4))}${digits.slice(-4)}`;
    return suffix ? `${masked}@${suffix}` : masked;
  }
  if (raw.length <= 4) return '****';
  return `${'*'.repeat(Math.max(4, raw.length - 4))}${raw.slice(-4)}`;
}

function summarizeEvolutionResponse(responseBody) {
  if (!responseBody || typeof responseBody !== 'object') return { type: typeof responseBody };
  const key = responseBody.key || responseBody.message?.key || responseBody.data?.key || {};
  return {
    ok: responseBody.ok ?? null,
    status: responseBody.status ?? responseBody.data?.status ?? null,
    messageId: maskTechnicalIdentity(key.id || responseBody.id || responseBody.messageId || responseBody.data?.id),
    remoteJid: maskTechnicalIdentity(key.remoteJid || responseBody.remoteJid || responseBody.data?.remoteJid),
    fromMe: key.fromMe ?? null,
  };
}

function normalizeRecipient(value) {
  const raw = String(value || '').trim();
  if (/@(?:s\.whatsapp\.net|lid)$/i.test(raw)) return raw;
  return normalizePhone(raw);
}

export class EvolutionClient {
  constructor({ baseUrl, apiKey, instanceName, fetchImpl = fetch, timeoutMs = 10000 } = {}) {
    this.baseUrl = String(baseUrl || '').replace(/\/$/, '');
    this.apiKey = String(apiKey || '');
    this.instanceName = String(instanceName || '');
    this.fetchImpl = fetchImpl;
    this.timeoutMs = timeoutMs;
  }

  isConfigured() {
    return Boolean(this.baseUrl && this.apiKey && this.instanceName);
  }

  async sendText(phone, text) {
    if (!this.isConfigured()) throw new Error('EVOLUTION_API_NOT_CONFIGURED');
    const number = normalizeRecipient(phone);
    const safeText = String(text || '').trim().slice(0, 4000);
    if (!number || !safeText) throw new Error('INVALID_WHATSAPP_MESSAGE');

    let lastError = null;
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
      try {
        console.log('WHATSAPP_SEND_START', {
          instanceName: this.instanceName,
          attempt,
          textLength: safeText.length,
        });
        console.log('SEND_INSTANCE_USED', {
          instanceName: this.instanceName,
          configured: this.isConfigured(),
        });
        console.log('WHATSAPP_SEND_DESTINATION', {
          instanceName: this.instanceName,
          inputTarget: maskTechnicalIdentity(phone),
          normalizedTarget: maskTechnicalIdentity(number),
        });
        console.log('WHATSAPP_SEND_PAYLOAD', {
          endpoint: `/message/sendText/${this.instanceName}`,
          payload: {
            number: maskTechnicalIdentity(number),
            textLength: safeText.length,
          },
        });
        console.log('EVOLUTION_SEND_TEXT_REQUEST', {
          instanceName: this.instanceName,
          attempt,
          inputTarget: maskTechnicalIdentity(phone),
          normalizedTarget: maskTechnicalIdentity(number),
          textLength: safeText.length,
        });
        const response = await this.fetchImpl(
          `${this.baseUrl}/message/sendText/${encodeURIComponent(this.instanceName)}`,
          {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              apikey: this.apiKey,
            },
            body: JSON.stringify({
              number,
              text: safeText,
            }),
            signal: controller.signal,
          },
        );
        const responseBody = await response.json().catch(() => ({ ok: true }));
        console.log('WHATSAPP_SEND_STATUS', {
          instanceName: this.instanceName,
          attempt,
          responseOk: response.ok,
          httpStatus: response.status ?? null,
        });
        console.log('WHATSAPP_SEND_RESPONSE', {
          instanceName: this.instanceName,
          normalizedTarget: maskTechnicalIdentity(number),
          response: summarizeEvolutionResponse(responseBody),
        });
        console.log('EVOLUTION_SEND_TEXT_RESPONSE', {
          instanceName: this.instanceName,
          attempt,
          normalizedTarget: maskTechnicalIdentity(number),
          responseOk: response.ok,
          httpStatus: response.status ?? null,
          response: summarizeEvolutionResponse(responseBody),
        });
        if (!response.ok) throw new Error(`EVOLUTION_SEND_FAILED_${response.status}`);
        return responseBody;
      } catch (error) {
        lastError = error;
        console.error('WHATSAPP_SEND_ERROR', {
          instanceName: this.instanceName,
          attempt,
          normalizedTarget: maskTechnicalIdentity(number),
          message: error.message,
        });
        console.error('EVOLUTION_SEND_TEXT_ERROR', {
          instanceName: this.instanceName,
          attempt,
          normalizedTarget: maskTechnicalIdentity(number),
          message: error.message,
        });
        if (attempt < 3) await delay(attempt * 300);
      } finally {
        clearTimeout(timeout);
      }
    }
    throw lastError || new Error('EVOLUTION_SEND_FAILED');
  }
}

export default EvolutionClient;
