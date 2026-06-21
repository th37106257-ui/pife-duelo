import { normalizePhone } from './PaymentService.js';

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
    const number = normalizePhone(phone);
    const safeText = String(text || '').trim().slice(0, 4000);
    if (!number || !safeText) throw new Error('INVALID_WHATSAPP_MESSAGE');

    let lastError = null;
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
      try {
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
              textMessage: { text: safeText },
            }),
            signal: controller.signal,
          },
        );
        if (!response.ok) throw new Error(`EVOLUTION_SEND_FAILED_${response.status}`);
        return await response.json().catch(() => ({ ok: true }));
      } catch (error) {
        lastError = error;
        if (attempt < 3) await delay(attempt * 300);
      } finally {
        clearTimeout(timeout);
      }
    }
    throw lastError || new Error('EVOLUTION_SEND_FAILED');
  }
}

export default EvolutionClient;
