'use strict';
/**
 * WhatsApp BSP (Business Solution Provider) service.
 * Supports: 360dialog, Twilio, Meta Cloud API (direct).
 * All providers expose the same sendTemplate() interface.
 */
const { decrypt } = require('./encryption');

const DEFAULT_COUNTRY = process.env.WA_DEFAULT_COUNTRY_CODE || '91';
const GRAPH_API_VERSION = process.env.WA_GRAPH_API_VERSION || 'v19.0';

class WaApiError extends Error {
  constructor(code, message) {
    super(message || `WhatsApp API error ${code}`);
    this.code = String(code);
    // Meta error code reference:
    // 130429 : rate limit hit → exponential backoff
    // 131026 : phone not on WhatsApp → mark invalid, do not retry
    // 131047 : re-engagement required (need 24h session) → fail gracefully
    // 131056 : per-second send limit → short backoff
    // 132000 : template not found / rejected → fail hard
    // 132001 : template param count mismatch → fail hard
  }
}

class WaBspService {
  constructor(phoneNumberRecord) {
    this.phone = phoneNumberRecord;
    this.bsp   = phoneNumberRecord.bsp;
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  async sendTemplate(to, templateName, language, components) {
    switch (this.bsp) {
      case '360dialog':  return this._send360dialog(to, templateName, language, components);
      case 'twilio':     return this._sendTwilio(to, templateName, language, components);
      case 'meta_cloud': return this._sendMetaCloud(to, templateName, language, components);
      default: throw new Error(`Unknown BSP: ${this.bsp}`);
    }
  }

  async getQualityRating() {
    const token = decrypt(this.phone.access_token);
    if (!token) return this.phone.quality_score || 'GREEN';
    const res  = await fetch(
      `https://graph.facebook.com/${GRAPH_API_VERSION}/${this.phone.phone_number_id}?fields=quality_rating`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    const data = await res.json();
    return data.quality_rating || 'GREEN';
  }

  // ── 360dialog ──────────────────────────────────────────────────────────────

  async _send360dialog(to, templateName, language, components) {
    const apiKey = decrypt(this.phone.bsp_api_key);
    const res = await fetch('https://waba.360dialog.io/v1/messages', {
      method:  'POST',
      headers: { 'D360-API-KEY': apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        to:       to.replace('+', ''),
        type:     'template',
        template: {
          namespace: this.phone.waba_id,
          name:      templateName,
          language:  { policy: 'deterministic', code: language },
          components,
        },
      }),
    });
    const data = await res.json();
    if (!res.ok) {
      const err = data.errors?.[0];
      throw new WaApiError(err?.code || res.status, err?.title || 'Unknown 360dialog error');
    }
    return { wamid: data.messages[0].id, provider: '360dialog' };
  }

  // ── Twilio ─────────────────────────────────────────────────────────────────

  async _sendTwilio(to, templateName, language, components) {
    const sid   = process.env.TWILIO_ACCOUNT_SID;
    const token = process.env.TWILIO_AUTH_TOKEN;
    if (!sid || !token) throw new Error('Twilio credentials not configured');

    const bodyVars = components.find(c => c.type === 'body')?.parameters?.map(p => p.text) || [];
    const contentVariables = JSON.stringify(
      Object.fromEntries(bodyVars.map((v, i) => [i + 1, v])),
    );

    // Twilio uses REST API
    const auth    = Buffer.from(`${sid}:${token}`).toString('base64');
    const payload = new URLSearchParams({
      From:             `whatsapp:${this.phone.phone_number}`,
      To:               `whatsapp:${to}`,
      ContentSid:       this.phone.twilio_content_sid_map?.[templateName] || '',
      ContentVariables: contentVariables,
    });
    const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
      method:  'POST',
      headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/x-www-form-urlencoded' },
      body:    payload,
    });
    const data = await res.json();
    if (!res.ok) throw new WaApiError(res.status, data.message || 'Unknown Twilio error');
    return { wamid: data.sid, provider: 'twilio' };
  }

  // ── Meta Cloud API ─────────────────────────────────────────────────────────

  async _sendMetaCloud(to, templateName, language, components) {
    const token      = decrypt(this.phone.access_token);
    const phoneId    = this.phone.phone_number_id;
    const res = await fetch(
      `https://graph.facebook.com/${GRAPH_API_VERSION}/${phoneId}/messages`,
      {
        method:  'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messaging_product: 'whatsapp',
          recipient_type:    'individual',
          to:                to.replace('+', ''),
          type:              'template',
          template:          { name: templateName, language: { code: language }, components },
        }),
      },
    );
    const data = await res.json();
    if (data.error) throw new WaApiError(data.error.code, data.error.message);
    return { wamid: data.messages[0].id, provider: 'meta_cloud' };
  }

  // ── Static Helpers ─────────────────────────────────────────────────────────

  /**
   * Normalize to E.164 format.
   * 10-digit Indian numbers automatically get +91 prefix.
   */
  static normalizePhone(phone, countryCode = DEFAULT_COUNTRY) {
    if (!phone) return null;
    let cleaned = String(phone).replace(/[^\d+]/g, '');
    if (cleaned.startsWith('+')) return cleaned;
    if (cleaned.startsWith('00')) cleaned = cleaned.slice(2);
    if (cleaned.length === 10 && countryCode === '91') return `+91${cleaned}`;
    if (cleaned.length === 12 && cleaned.startsWith('91')) return `+${cleaned}`;
    return `+${countryCode}${cleaned}`;
  }

  static isValidE164(phone) {
    return /^\+[1-9]\d{6,14}$/.test(phone || '');
  }

  /**
   * Build Meta-format template components from a template record + contact data.
   */
  static buildComponents(template, contact, variableMapping, personalizedVars = {}) {
    const components = [];

    // Header
    if (template.header_type === 'IMAGE' && template.header_content) {
      components.push({
        type:       'header',
        parameters: [{ type: 'image', image: { link: template.header_content } }],
      });
    } else if (template.header_type === 'TEXT' && template.header_content) {
      components.push({
        type:       'header',
        parameters: [{ type: 'text', text: template.header_content }],
      });
    }

    // Body variables
    const varCount   = (template.body_text.match(/\{\{\d+\}\}/g) || []).length;
    const bodyParams = [];
    for (let i = 1; i <= varCount; i++) {
      const fieldName = variableMapping?.[String(i)];
      let value = personalizedVars?.[i]
        || (fieldName ? (contact[fieldName] || contact.custom_fields?.[fieldName] || '') : '');
      value = String(value).slice(0, 1024);
      bodyParams.push({ type: 'text', text: value || ' ' }); // Meta rejects empty params
    }
    if (bodyParams.length) components.push({ type: 'body', parameters: bodyParams });

    // Buttons (URL type — for dynamic suffix tracking)
    const buttons = Array.isArray(template.buttons) ? template.buttons : [];
    buttons.forEach((btn, idx) => {
      if (btn.type === 'URL' && btn.url?.includes('{{1}}')) {
        components.push({
          type:       'button',
          sub_type:   'url',
          index:      String(idx),
          parameters: [{ type: 'text', text: '' }],
        });
      }
    });

    return components;
  }

  /**
   * Bearer token for WhatsApp Business Management API (template create / list).
   * Meta Cloud: system user access token. 360dialog: API key as Bearer on graph.facebook.com.
   */
  static _managementBearerToken(phone) {
    if (phone.bsp === 'meta_cloud') return decrypt(phone.access_token);
    if (phone.bsp === '360dialog') return decrypt(phone.bsp_api_key);
    return null;
  }

  /** Map Meta template status string to wa_templates.status CHECK values */
  static mapMetaManagementStatusToDb(metaStatus) {
    const s = String(metaStatus || '').toUpperCase();
    if (s === 'APPROVED') return 'APPROVED';
    if (s === 'REJECTED') return 'REJECTED';
    if (s === 'PAUSED' || s === 'DISABLED') return 'PAUSED';
    return 'PENDING';
  }

  /**
   * Whether a stored language code (e.g. en, en_IN) matches Meta's (e.g. en_US, en_IN).
   */
  static languagesMatchForSync(stored, metaLang) {
    if (!stored || !metaLang) return false;
    if (stored === metaLang) return true;
    const storedBase = String(stored).split('_')[0];
    const metaBase   = String(metaLang).split('_')[0];
    if (storedBase === metaBase && (stored === metaLang || metaLang.startsWith(`${stored}_`))) return true;
    if (stored === metaBase && metaLang.startsWith(`${stored}_`)) return true;
    return false;
  }

  /**
   * Build `components` array for POST /{waba-id}/message_templates (Business Management API).
   */
  static buildMetaManagementTemplateComponents(fields) {
    const {
      header_type, header_content, body_text, footer_text, buttons,
    } = fields;
    const components = [];

    if (header_type === 'TEXT' && header_content) {
      const comp = { type: 'HEADER', format: 'TEXT', text: header_content };
      const headerPlaceholders = [...header_content.matchAll(/\{\{(\d+)\}\}/g)];
      if (headerPlaceholders.length) {
        const headerNums = [...new Set(headerPlaceholders.map((m) => parseInt(m[1], 10)))].sort((a, b) => a - b);
        comp.example = { header_text: headerNums.map((n) => `Sample${n}`) };
      }
      components.push(comp);
    }

    const bodyComp = { type: 'BODY', text: body_text };
    const bodyNums = [...new Set(
      [...String(body_text).matchAll(/\{\{(\d+)\}\}/g)].map((m) => parseInt(m[1], 10)),
    )].sort((a, b) => a - b);
    if (bodyNums.length) {
      bodyComp.example = { body_text: [bodyNums.map((n) => `Sample${n}`)] };
    }
    components.push(bodyComp);

    if (footer_text && String(footer_text).trim()) {
      components.push({ type: 'FOOTER', text: String(footer_text).trim().slice(0, 60) });
    }

    const btnArr = Array.isArray(buttons) ? buttons : [];
    const metaButtons = [];
    for (const b of btnArr) {
      if (!b || !b.text) continue;
      const t = String(b.type || 'QUICK_REPLY').toUpperCase();
      if (t === 'QUICK_REPLY') metaButtons.push({ type: 'QUICK_REPLY', text: String(b.text).slice(0, 25) });
      else if (t === 'URL') {
        const url = (b.url || '').trim();
        if (!url) continue;
        const btn = { type: 'URL', text: String(b.text).slice(0, 25), url };
        const urlVars = [...url.matchAll(/\{\{(\d+)\}\}/g)];
        if (urlVars.length) btn.example = urlVars.map((_, i) => `ex${i + 1}`);
        metaButtons.push(btn);
      } else if (t === 'PHONE_NUMBER') {
        const raw = (b.phone_number || b.phone || '').replace(/\D/g, '');
        if (!raw) continue;
        metaButtons.push({ type: 'PHONE_NUMBER', text: String(b.text).slice(0, 25), phone_number: raw });
      }
    }
    if (metaButtons.length) components.push({ type: 'BUTTONS', buttons: metaButtons.slice(0, 3) });

    return components;
  }

  /**
   * Create a message template on Meta (submitted for review). Same Graph edge works for many 360dialog keys.
   * @returns {{ ok: true, id: string, status: string } | { ok: false, message: string, code?: string }}
   */
  static async submitMessageTemplateCreate(phone, fields) {
    if (!['meta_cloud', '360dialog'].includes(phone.bsp)) {
      return { ok: false, message: 'Template submission from the dashboard is supported for Meta Cloud API and 360dialog only. Add templates in Twilio or your BSP console for other providers.' };
    }
    if (fields.header_type === 'IMAGE') {
      return { ok: false, message: 'IMAGE headers require a media upload handle from Meta; create this template in WhatsApp Manager or switch to a text header for dashboard submission.' };
    }

    const token = WaBspService._managementBearerToken(phone);
    if (!token) {
      return { ok: false, message: `Missing ${phone.bsp === 'meta_cloud' ? 'access token' : 'API key'} for this phone number.` };
    }

    const wabaId = phone.waba_id;
    if (!wabaId) return { ok: false, message: 'Missing WABA ID on phone record.' };

    const name     = String(fields.name || '').toLowerCase().replace(/\s+/g, '_');
    const category = String(fields.category || 'UTILITY').toUpperCase();
    const language = String(fields.language || 'en');
    const components = WaBspService.buildMetaManagementTemplateComponents(fields);

    const url  = `https://graph.facebook.com/${GRAPH_API_VERSION}/${wabaId}/message_templates`;
    const body = { name, language, category, components };
    const res  = await fetch(url, {
      method:  'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body:    JSON.stringify(body),
    });
    const data = await res.json();
    if (data.error) {
      const msg = data.error.error_user_msg || data.error.message || 'Meta API error';
      return { ok: false, message: msg, code: String(data.error.code || '') };
    }
    const id     = data.id || data.hsm_id || null;
    const status = data.status || 'PENDING';
    return { ok: true, id: id ? String(id) : null, status: String(status).toUpperCase() };
  }

  /** List all message templates for the WABA (paginated). */
  static async fetchAllMessageTemplates(phone) {
    const token = WaBspService._managementBearerToken(phone);
    if (!token) throw new Error('Missing API credentials for template sync.');
    const wabaId = phone.waba_id;
    const fields = encodeURIComponent('id,name,status,language,category');
    let nextUrl    = `https://graph.facebook.com/${GRAPH_API_VERSION}/${wabaId}/message_templates?fields=${fields}&limit=100`;
    const all      = [];
    while (nextUrl) {
      const res  = await fetch(nextUrl, { headers: { Authorization: `Bearer ${token}` } });
      const data = await res.json();
      if (data.error) throw new Error(data.error.message || 'Failed to list templates');
      all.push(...(data.data || []));
      nextUrl = data.paging?.next || null;
    }
    return all;
  }
}

module.exports = { WaBspService, WaApiError };
