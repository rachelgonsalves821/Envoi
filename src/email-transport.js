import { Resend } from 'resend';

const disabledReason = ({ provider, apiKey, webhookSecret, publicDomain, domainVerified }) => {
  if (provider !== 'resend') return 'SINALOA_EMAIL_PROVIDER must be set to resend';
  if (!apiKey) return 'RESEND_API_KEY is required';
  if (!webhookSecret) return 'RESEND_WEBHOOK_SECRET is required';
  if (!publicDomain) return 'SINALOA_PUBLIC_EMAIL_DOMAIN is required';
  if (publicDomain.length > 253 || !/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(publicDomain)) return 'SINALOA_PUBLIC_EMAIL_DOMAIN must be a valid public DNS name';
  if (publicDomain === 'sinaloa.mail' || publicDomain.endsWith('.mail')) return '.mail is not a delegated public top-level domain';
  if (!domainVerified) return 'SINALOA_EMAIL_DOMAIN_VERIFIED=true is required after provider DNS verification';
  return null;
};

const transportError = error => {
  const statusCode = Number(error?.statusCode || error?.status || 0) || null;
  const wrapped = new Error(error?.message || 'Email provider request failed');
  wrapped.statusCode = statusCode;
  wrapped.providerCode = error?.name || error?.code || null;
  wrapped.permanent = Boolean(statusCode && statusCode >= 400 && statusCode < 500 && ![408, 409, 429].includes(statusCode));
  return wrapped;
};

export class ResendEmailTransport {
  constructor({
    provider = process.env.SINALOA_EMAIL_PROVIDER || 'disabled',
    apiKey = process.env.RESEND_API_KEY || '',
    webhookSecret = process.env.RESEND_WEBHOOK_SECRET || '',
    publicDomain = String(process.env.SINALOA_PUBLIC_EMAIL_DOMAIN || '').trim().toLowerCase(),
    domainVerified = process.env.SINALOA_EMAIL_DOMAIN_VERIFIED === 'true',
    baseUrl = process.env.RESEND_API_BASE_URL || undefined
  } = {}) {
    this.provider = provider;
    this.webhookSecret = webhookSecret;
    this.publicDomain = publicDomain;
    this.domainVerified = domainVerified;
    this.reason = disabledReason({ provider, apiKey, webhookSecret, publicDomain, domainVerified });
    this.client = apiKey ? new Resend(apiKey, baseUrl ? { baseUrl } : undefined) : null;
  }

  get ready() { return !this.reason; }

  status() {
    return {
      provider: this.provider,
      ready: this.ready,
      publicDomain: this.publicDomain || null,
      domainVerified: this.domainVerified,
      reason: this.reason
    };
  }

  assertReady() {
    if (!this.ready) throw Object.assign(new Error(`External email transport is not ready: ${this.reason}`), { statusCode: 503, permanent: true });
  }

  addressForSlug(slug) {
    return this.publicDomain ? `${slug}@${this.publicDomain}` : null;
  }

  async send({ from, to, subject, text, html, replyTo, idempotencyKey }) {
    this.assertReady();
    const { data, error } = await this.client.emails.send({
      from,
      to: [to],
      subject,
      ...(text ? { text } : {}),
      ...(html ? { html } : {}),
      ...(replyTo ? { replyTo } : {})
    }, { idempotencyKey });
    if (error) throw transportError(error);
    if (!data?.id) throw new Error('Email provider returned no delivery identifier');
    return { provider: 'resend', providerMessageId: data.id };
  }

  verifyWebhook(rawPayload, headers) {
    if (!this.webhookSecret || !this.client) throw Object.assign(new Error('Email webhook verification is not configured'), { statusCode: 503 });
    try {
      return this.client.webhooks.verify({
        payload: rawPayload,
        headers: {
          id: String(headers['svix-id'] || ''),
          timestamp: String(headers['svix-timestamp'] || ''),
          signature: String(headers['svix-signature'] || '')
        },
        webhookSecret: this.webhookSecret
      });
    } catch {
      throw Object.assign(new Error('Invalid email webhook signature'), { statusCode: 401 });
    }
  }

  async retrieveInbound(emailId) {
    this.assertReady();
    const { data, error } = await this.client.emails.receiving.get(emailId, { html_format: 'cid' });
    if (error) throw transportError(error);
    return data;
  }
}

export const createEmailTransport = options => new ResendEmailTransport(options);
