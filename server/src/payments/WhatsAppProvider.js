import { EvolutionClient } from './EvolutionClient.js';
import { MetaCloudClient } from './MetaCloudClient.js';

export function normalizeWhatsAppProvider(value) {
  const provider = String(value || 'evolution').trim().toLowerCase();
  return provider === 'meta_cloud' ? 'meta_cloud' : 'evolution';
}

export class WhatsAppProvider {
  constructor({
    requestedProvider = 'evolution',
    evolutionClient,
    metaCloudClient,
    logInfo = console.log,
    logWarn = console.warn,
    logError = console.error,
  } = {}) {
    this.providerName = 'whatsapp_provider';
    this.requestedProvider = normalizeWhatsAppProvider(requestedProvider);
    this.evolutionClient = evolutionClient;
    this.metaCloudClient = metaCloudClient;
    this.logInfo = logInfo;
    this.logWarn = logWarn;
    this.logError = logError;
    this.instanceName = this.getPrimaryClient()?.instanceName || this.requestedProvider;
  }

  getPrimaryProviderName() {
    return this.requestedProvider;
  }

  getFallbackProviderName() {
    return this.requestedProvider === 'meta_cloud' ? 'evolution' : null;
  }

  getPrimaryClient() {
    return this.requestedProvider === 'meta_cloud' ? this.metaCloudClient : this.evolutionClient;
  }

  getFallbackClient() {
    return this.requestedProvider === 'meta_cloud' ? this.evolutionClient : null;
  }

  getActiveProviderName() {
    const primary = this.getPrimaryClient();
    if (primary?.isConfigured?.()) return this.getPrimaryProviderName();
    const fallback = this.getFallbackClient();
    if (fallback?.isConfigured?.()) return this.getFallbackProviderName();
    return this.getPrimaryProviderName();
  }

  isConfigured() {
    return Boolean(this.getPrimaryClient()?.isConfigured?.() || this.getFallbackClient()?.isConfigured?.());
  }

  getDiagnostics() {
    const primary = this.getPrimaryClient();
    const fallback = this.getFallbackClient();
    const active = this.getActiveProviderName();
    const activeClient = active === 'meta_cloud' ? this.metaCloudClient : this.evolutionClient;
    const activeDiagnostics = activeClient?.getDiagnostics?.() ?? {};
    const metaDiagnostics = this.metaCloudClient?.getDiagnostics?.() ?? {};
    return {
      ...activeDiagnostics,
      provider: 'whatsapp_provider',
      requestedProvider: this.requestedProvider,
      activeProvider: active,
      fallbackProvider: this.getFallbackProviderName(),
      configured: this.isConfigured(),
      primaryConfigured: Boolean(primary?.isConfigured?.()),
      fallbackConfigured: Boolean(fallback?.isConfigured?.()),
      evolutionConfigured: Boolean(this.evolutionClient?.isConfigured?.()),
      metaCloudConfigured: Boolean(this.metaCloudClient?.isConfigured?.()),
      metaPhoneNumberIdConfigured: Boolean(metaDiagnostics.phoneNumberIdConfigured),
      metaTokenConfigured: Boolean(metaDiagnostics.tokenConfigured),
      metaVerifyTokenConfigured: Boolean(metaDiagnostics.verifyTokenConfigured),
      metaAppSecretConfigured: Boolean(metaDiagnostics.appSecretConfigured),
      metaGraphApiVersionConfigured: Boolean(metaDiagnostics.graphApiVersionConfigured),
      metaConfigurationErrors: metaDiagnostics.configurationErrors ?? [],
      primary: primary?.getDiagnostics?.() ?? null,
      fallback: fallback?.getDiagnostics?.() ?? null,
    };
  }

  recordWebhookReceived(payload = {}) {
    this.getPrimaryClient()?.recordWebhookReceived?.(payload);
    this.getFallbackClient()?.recordWebhookReceived?.(payload);
  }

  recordMessageProcessed(metadata = {}) {
    this.getPrimaryClient()?.recordMessageProcessed?.(metadata);
    this.getFallbackClient()?.recordMessageProcessed?.(metadata);
  }

  async checkInstanceStatus() {
    const primary = this.getPrimaryClient();
    if (primary?.isConfigured?.()) return primary.checkInstanceStatus?.() ?? { ok: true, isOpen: true, state: 'configured' };

    const fallback = this.getFallbackClient();
    if (fallback?.isConfigured?.()) {
      this.logWarn('WHATSAPP_PROVIDER_FALLBACK_USED', {
        requestedProvider: this.requestedProvider,
        fallbackProvider: this.getFallbackProviderName(),
        reason: 'primary_not_configured',
      });
      return fallback.checkInstanceStatus?.() ?? { ok: true, isOpen: true, state: 'configured' };
    }

    return {
      ok: false,
      isOpen: false,
      state: 'not_configured',
      reason: 'WHATSAPP_PROVIDER_NOT_CONFIGURED',
      provider: this.requestedProvider,
    };
  }

  buildSendPayloadPreview(phone, text) {
    const active = this.getActiveProviderName();
    const activeClient = active === 'meta_cloud' ? this.metaCloudClient : this.evolutionClient;
    return activeClient?.buildSendPayloadPreview?.(phone, text) ?? {
      provider: active,
      payload: { textLength: String(text || '').length },
    };
  }

  async sendWhatsAppMessage(phone, text, options = {}) {
    const primary = this.getPrimaryClient();
    const fallback = this.getFallbackClient();
    const primaryName = this.getPrimaryProviderName();
    const fallbackName = this.getFallbackProviderName();

    if (primary?.isConfigured?.()) {
      let result;
      try {
        result = await primary.sendWhatsAppMessage(phone, text, {
          ...options,
          throwOnFailure: false,
        });
      } catch (error) {
        result = {
          ok: false,
          sent: false,
          provider: primaryName,
          reason: error.message || 'primary_send_failed',
          error: error.message,
        };
      }
      if (result?.ok !== false) return { ...result, provider: result.provider || primaryName };

      if (fallback?.isConfigured?.()) {
        this.logWarn('WHATSAPP_PROVIDER_FALLBACK_USED', {
          requestedProvider: primaryName,
          fallbackProvider: fallbackName,
          reason: result.reason || result.error || 'primary_send_failed',
        });
        const fallbackResult = await fallback.sendWhatsAppMessage(phone, text, {
          ...options,
          throwOnFailure: false,
        });
        return { ...fallbackResult, provider: fallbackResult.provider || fallbackName, fallbackUsed: true };
      }

      return { ...result, provider: result.provider || primaryName };
    }

    if (fallback?.isConfigured?.()) {
      this.logWarn('WHATSAPP_PROVIDER_FALLBACK_USED', {
        requestedProvider: primaryName,
        fallbackProvider: fallbackName,
        reason: 'primary_not_configured',
      });
      const fallbackResult = await fallback.sendWhatsAppMessage(phone, text, {
        ...options,
        throwOnFailure: false,
      });
      return { ...fallbackResult, provider: fallbackResult.provider || fallbackName, fallbackUsed: true };
    }

    const result = {
      ok: false,
      sent: false,
      provider: primaryName,
      reason: 'WHATSAPP_PROVIDER_NOT_CONFIGURED',
    };
    this.logError('WHATSAPP_SEND_FAILED', result);
    return result;
  }

  async sendText(phone, text, options = {}) {
    const result = await this.sendWhatsAppMessage(phone, text, {
      ...options,
      throwOnFailure: options.throwOnFailure ?? true,
    });
    return result.rawResponse ?? result;
  }
}

export function createWhatsAppProvider({ config, fetchImpl = fetch, logInfo, logWarn, logError } = {}) {
  const evolutionClient = new EvolutionClient({
    baseUrl: config?.EVOLUTION_API_URL,
    apiKey: config?.EVOLUTION_API_KEY,
    instanceName: config?.EVOLUTION_INSTANCE_NAME,
    fetchImpl,
  });
  const metaCloudClient = new MetaCloudClient({
    token: config?.META_WHATSAPP_TOKEN,
    phoneNumberId: config?.META_PHONE_NUMBER_ID,
    verifyToken: config?.META_VERIFY_TOKEN,
    appSecret: config?.META_APP_SECRET,
    graphApiVersion: config?.META_GRAPH_API_VERSION,
    fetchImpl,
  });
  const client = new WhatsAppProvider({
    requestedProvider: config?.WHATSAPP_PROVIDER,
    evolutionClient,
    metaCloudClient,
    logInfo,
    logWarn,
    logError,
  });

  return {
    client,
    evolutionClient,
    metaCloudClient,
    requestedProvider: client.getPrimaryProviderName(),
    activeProviderName: client.getActiveProviderName(),
    fallbackProviderName: client.getFallbackProviderName(),
  };
}

export default WhatsAppProvider;
