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
    error: responseBody.error ?? responseBody.message?.error ?? responseBody.data?.error ?? null,
    message: typeof responseBody.message === 'string' ? responseBody.message.slice(0, 200) : null,
    messageId: maskTechnicalIdentity(key.id || responseBody.id || responseBody.messageId || responseBody.data?.id),
    remoteJid: maskTechnicalIdentity(key.remoteJid || responseBody.remoteJid || responseBody.data?.remoteJid),
    fromMe: key.fromMe ?? null,
  };
}

function sanitizeEvolutionResponse(responseBody, depth = 0) {
  if (responseBody == null) return responseBody;
  if (depth > 3) return '<nested>';
  if (typeof responseBody === 'string') return responseBody.slice(0, 500);
  if (typeof responseBody !== 'object') return responseBody;
  if (Array.isArray(responseBody)) {
    return responseBody.slice(0, 10).map((item) => sanitizeEvolutionResponse(item, depth + 1));
  }
  return Object.fromEntries(Object.entries(responseBody).slice(0, 30).map(([key, value]) => {
    if (/key|token|secret|password|apikey/i.test(key)) return [key, '<hidden>'];
    if (/jid|phone|number|remote/i.test(key)) return [key, maskTechnicalIdentity(value)];
    return [key, sanitizeEvolutionResponse(value, depth + 1)];
  }));
}

function normalizeRecipientDetails(value) {
  const raw = String(value || '').trim();
  const jidMatch = raw.match(/^([^@]+)@(s\.whatsapp\.net|lid)$/i);
  if (jidMatch) {
    return {
      input: raw,
      value: raw,
      kind: jidMatch[2].toLowerCase(),
      hasJid: true,
      hasDuplicatedJid: /@.*@/.test(raw),
    };
  }
  const normalizedPhone = normalizePhone(raw);
  return {
    input: raw,
    value: normalizedPhone,
    kind: 'phone',
    hasJid: false,
    hasDuplicatedJid: /@.*@/.test(raw),
  };
}

function normalizeRecipient(value) {
  return normalizeRecipientDetails(value).value;
}

function extractInstanceState(responseBody = {}) {
  const candidates = [
    responseBody?.instance?.state,
    responseBody?.instance?.connectionStatus,
    responseBody?.instance?.status,
    responseBody?.data?.state,
    responseBody?.data?.connectionStatus,
    responseBody?.data?.status,
    responseBody?.state,
    responseBody?.connectionStatus,
    responseBody?.status,
  ];
  return String(candidates.find((item) => item != null) || '').trim().toLowerCase();
}

function isOpenState(value) {
  const state = String(value || '').trim().toLowerCase();
  return ['open', 'connected', 'connection_open', 'online', 'ready'].includes(state);
}

function errorMessage(error) {
  return error?.name === 'AbortError' ? 'request_timeout' : (error?.message || String(error));
}

export class EvolutionClient {
  constructor({ baseUrl, apiKey, instanceName, fetchImpl = fetch, timeoutMs = 10000 } = {}) {
    this.baseUrl = String(baseUrl || '').replace(/\/$/, '');
    this.apiKey = String(apiKey || '');
    this.instanceName = String(instanceName || '');
    this.fetchImpl = fetchImpl;
    this.timeoutMs = timeoutMs;
    this.diagnostics = {
      instanceName: this.instanceName || null,
      lastStatusCheckAt: null,
      lastStatus: null,
      lastStatusHttpStatus: null,
      lastStatusError: null,
      lastWebhookReceivedAt: null,
      lastWebhookEvent: null,
      lastWebhookInstance: null,
      lastMessageProcessedAt: null,
      lastMessageFrom: null,
      lastSendAttemptAt: null,
      lastSendTarget: null,
      lastSendHttpStatus: null,
      lastSendSuccessAt: null,
      lastSendErrorAt: null,
      lastError: null,
      lastResponse: null,
      reconnectNeeded: false,
    };
  }

  isConfigured() {
    return Boolean(this.baseUrl && this.apiKey && this.instanceName);
  }

  getDiagnostics() {
    return {
      ...this.diagnostics,
      configured: this.isConfigured(),
      instanceName: this.instanceName || null,
      apiUrlConfigured: Boolean(this.baseUrl),
      apiKeyConfigured: Boolean(this.apiKey),
    };
  }

  recordWebhookReceived(payload = {}) {
    this.diagnostics.lastWebhookReceivedAt = new Date().toISOString();
    this.diagnostics.lastWebhookEvent = payload?.event ?? null;
    this.diagnostics.lastWebhookInstance = payload?.instance ?? null;
  }

  recordMessageProcessed({ phone = null } = {}) {
    this.diagnostics.lastMessageProcessedAt = new Date().toISOString();
    this.diagnostics.lastMessageFrom = maskTechnicalIdentity(phone) || null;
  }

  async checkInstanceStatus() {
    const checkedAt = new Date().toISOString();
    this.diagnostics.lastStatusCheckAt = checkedAt;

    if (!this.isConfigured()) {
      const result = {
        ok: false,
        isOpen: false,
        state: 'not_configured',
        httpStatus: null,
        reason: 'EVOLUTION_API_NOT_CONFIGURED',
      };
      this.diagnostics.lastStatus = result.state;
      this.diagnostics.lastStatusError = result.reason;
      this.diagnostics.reconnectNeeded = true;
      console.warn('WHATSAPP_STATUS_CHECK', {
        instanceName: this.instanceName || null,
        configured: false,
        state: result.state,
        reason: result.reason,
      });
      console.warn('WHATSAPP_INSTANCE_CLOSED', {
        instanceName: this.instanceName || null,
        state: result.state,
        reason: result.reason,
      });
      console.warn('WHATSAPP_RECONNECT_NEEDED', {
        instanceName: this.instanceName || null,
        reason: result.reason,
      });
      return result;
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchImpl(
        `${this.baseUrl}/instance/connectionState/${encodeURIComponent(this.instanceName)}`,
        {
          method: 'GET',
          headers: { apikey: this.apiKey },
          signal: controller.signal,
        },
      );
      const responseBody = await response.json().catch(() => ({}));
      const state = extractInstanceState(responseBody) || (response.ok ? 'unknown' : 'status_error');
      const isOpen = isOpenState(state) ? true : (state === 'unknown' ? null : false);
      const result = {
        ok: response.ok,
        isOpen,
        state,
        httpStatus: response.status ?? null,
        response: summarizeEvolutionResponse(responseBody),
      };
      this.diagnostics.lastStatus = state;
      this.diagnostics.lastStatusHttpStatus = response.status ?? null;
      this.diagnostics.lastStatusError = response.ok ? null : `HTTP_${response.status}`;
      this.diagnostics.reconnectNeeded = isOpen === false;
      console.log('WHATSAPP_STATUS_CHECK', {
        instanceName: this.instanceName,
        configured: true,
        httpStatus: response.status ?? null,
        responseOk: response.ok,
        state,
        isOpen,
      });
      if (isOpen === true) {
        console.log('WHATSAPP_INSTANCE_OPEN', {
          instanceName: this.instanceName,
          state,
        });
      } else if (isOpen === false) {
        console.warn('WHATSAPP_INSTANCE_CLOSED', {
          instanceName: this.instanceName,
          state,
          httpStatus: response.status ?? null,
        });
        console.warn('WHATSAPP_RECONNECT_NEEDED', {
          instanceName: this.instanceName,
          state,
          reason: 'instance_not_open',
        });
      }
      return result;
    } catch (error) {
      const message = errorMessage(error);
      this.diagnostics.lastStatus = 'unknown';
      this.diagnostics.lastStatusError = message;
      this.diagnostics.lastError = message;
      console.warn('WHATSAPP_STATUS_CHECK', {
        instanceName: this.instanceName,
        configured: true,
        state: 'unknown',
        isOpen: null,
        error: message,
      });
      return {
        ok: false,
        isOpen: null,
        state: 'unknown',
        httpStatus: null,
        error: message,
        reason: 'status_check_failed',
      };
    } finally {
      clearTimeout(timeout);
    }
  }

  buildSendPayloadPreview(phone, text) {
    const recipient = normalizeRecipientDetails(phone);
    const safeText = String(text || '').trim().slice(0, 4000);
    return {
      endpoint: `/message/sendText/${this.instanceName}`,
      payload: {
        number: maskTechnicalIdentity(recipient.value),
        textLength: safeText.length,
      },
      target: maskTechnicalIdentity(recipient.value),
      targetKind: recipient.kind,
      hasJid: recipient.hasJid,
      hasDuplicatedJid: recipient.hasDuplicatedJid,
    };
  }

  async sendWhatsAppMessage(phone, text, {
    attempts = 3,
    checkStatus = true,
    throwOnFailure = false,
  } = {}) {
    const fail = (reason, extra = {}) => {
      const result = {
        ok: false,
        sent: false,
        reason,
        ...extra,
      };
      this.diagnostics.lastSendErrorAt = new Date().toISOString();
      this.diagnostics.lastError = reason;
      if (throwOnFailure) {
        const error = new Error(reason);
        Object.assign(error, result);
        throw error;
      }
      return result;
    };

    if (!this.isConfigured()) return fail('EVOLUTION_API_NOT_CONFIGURED');

    const recipient = normalizeRecipientDetails(phone);
    const number = recipient.value;
    const safeText = String(text || '').trim().slice(0, 4000);
    if (!number || !safeText || recipient.hasDuplicatedJid) {
      console.error('WHATSAPP_SEND_FAILED', {
        instanceName: this.instanceName,
        reason: recipient.hasDuplicatedJid ? 'duplicated_jid' : 'INVALID_WHATSAPP_MESSAGE',
        target: maskTechnicalIdentity(phone),
        normalizedTarget: maskTechnicalIdentity(number),
        targetKind: recipient.kind,
      });
      return fail(recipient.hasDuplicatedJid ? 'INVALID_WHATSAPP_DESTINATION_JID' : 'INVALID_WHATSAPP_MESSAGE', {
        target: maskTechnicalIdentity(number),
      });
    }

    if (checkStatus) {
      const status = await this.checkInstanceStatus();
      if (status.isOpen === false) {
        return fail('WHATSAPP_INSTANCE_NOT_OPEN', {
          status,
          reconnectNeeded: true,
        });
      }
    }

    let lastError = null;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
      const attemptedAt = new Date().toISOString();
      try {
        this.diagnostics.lastSendAttemptAt = attemptedAt;
        this.diagnostics.lastSendTarget = maskTechnicalIdentity(number);
        console.log('WHATSAPP_SEND_ATTEMPT', {
          instanceName: this.instanceName,
          attempt,
          target: maskTechnicalIdentity(number),
          targetKind: recipient.kind,
          textLength: safeText.length,
        });
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
          targetKind: recipient.kind,
          hasJid: recipient.hasJid,
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
        this.diagnostics.lastSendHttpStatus = response.status ?? null;
        this.diagnostics.lastResponse = summarizeEvolutionResponse(responseBody);
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
        if (!response.ok) {
          console.error('WHATSAPP_SEND_FAILED', {
            instanceName: this.instanceName,
            attempt,
            normalizedTarget: maskTechnicalIdentity(number),
            httpStatus: response.status ?? null,
            response: sanitizeEvolutionResponse(responseBody),
          });
          throw new Error(`EVOLUTION_SEND_FAILED_${response.status}`);
        }
        this.diagnostics.lastSendSuccessAt = new Date().toISOString();
        this.diagnostics.lastError = null;
        console.log('WHATSAPP_SEND_SUCCESS', {
          instanceName: this.instanceName,
          attempt,
          normalizedTarget: maskTechnicalIdentity(number),
          httpStatus: response.status ?? null,
          response: summarizeEvolutionResponse(responseBody),
        });
        return {
          ok: true,
          sent: true,
          httpStatus: response.status ?? null,
          response: summarizeEvolutionResponse(responseBody),
          rawResponse: sanitizeEvolutionResponse(responseBody),
          request: this.buildSendPayloadPreview(phone, safeText),
        };
      } catch (error) {
        lastError = error;
        const message = errorMessage(error);
        this.diagnostics.lastSendErrorAt = new Date().toISOString();
        this.diagnostics.lastError = message;
        console.error('WHATSAPP_SEND_FAILED', {
          instanceName: this.instanceName,
          attempt,
          normalizedTarget: maskTechnicalIdentity(number),
          message,
        });
        console.error('WHATSAPP_SEND_ERROR', {
          instanceName: this.instanceName,
          attempt,
          normalizedTarget: maskTechnicalIdentity(number),
          message,
        });
        console.error('EVOLUTION_SEND_TEXT_ERROR', {
          instanceName: this.instanceName,
          attempt,
          normalizedTarget: maskTechnicalIdentity(number),
          message,
        });
        if (attempt < attempts) await delay(attempt * 300);
      } finally {
        clearTimeout(timeout);
      }
    }
    return fail(errorMessage(lastError) || 'EVOLUTION_SEND_FAILED', {
      error: errorMessage(lastError),
      request: this.buildSendPayloadPreview(phone, safeText),
    });
  }

  async sendText(phone, text, options = {}) {
    const result = await this.sendWhatsAppMessage(phone, text, {
      ...options,
      checkStatus: options.checkStatus ?? false,
      throwOnFailure: options.throwOnFailure ?? true,
    });
    return result.rawResponse ?? result;
  }
}

export default EvolutionClient;
