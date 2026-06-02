'use strict';
const { connection: redis } = require('../config/redis');
const cache = require('../config/cache');

const DAILY_QUOTA  = parseInt(process.env.RESEND_DAILY_QUOTA || '100000', 10);
const RATE_LIMIT   = 10; // max sends per second (Resend limit)
const TODAY        = () => new Date().toISOString().slice(0, 10);

class ProviderRouter {
  async _getUsed() {
    const val = await redis.get(`provider_quota:resend:${TODAY()}`);
    return parseInt(val || '0', 10);
  }

  async _getHealth() {
    const val = await redis.get(cache.keys('').providerHealth('resend'));
    return parseInt(val || '100', 10);
  }

  async _getRateOk() {
    const key = 'provider_rate:resend';
    const now = Date.now();
    await redis.zremrangebyscore(key, '-inf', now - 1000);
    const cnt = await redis.zcard(key);
    return cnt < RATE_LIMIT;
  }

  // selectProvider kept for API compatibility — always returns 'resend'
  async selectProvider() {
    const [used, health, rateOk] = await Promise.all([
      this._getUsed(),
      this._getHealth(),
      this._getRateOk(),
    ]);

    if (used >= DAILY_QUOTA) throw new Error('Resend daily quota exhausted');
    if (health < 30)         throw new Error('Resend provider health too low — check bounce rates');
    if (!rateOk)             throw new Error('Resend rate limit reached — retry in 1 second');

    return 'resend';
  }

  async send(_provider, params) {
    const { Resend } = require('resend');
    const resend = new Resend(process.env.RESEND_API_KEY);

    try {
      const res = await resend.emails.send({
        from:    params.from,
        to:      [params.to],
        subject: params.subject,
        html:    params.html,
        headers: params.headers || {},
      });

      const messageId = res.data?.id || res.id || `resend-${Date.now()}`;

      // Track daily usage
      const quotaKey = `provider_quota:resend:${TODAY()}`;
      await redis.incr(quotaKey);
      await redis.expire(quotaKey, 86400);

      // Track per-second rate
      const rateKey = 'provider_rate:resend';
      await redis.zadd(rateKey, Date.now(), `${Date.now()}-${Math.random()}`);
      await redis.expire(rateKey, 5);

      return { messageId };
    } catch (err) {
      // Penalise health score on failure
      const healthKey = cache.keys('').providerHealth('resend');
      const current = parseInt(await redis.get(healthKey) || '100', 10);
      await redis.setex(healthKey, 3600, Math.max(0, current - 10));
      throw err;
    }
  }

  // Alias kept so existing callers don't break
  async sendWithFallback(params) {
    return this.send('resend', params);
  }
}

const providerRouter = new ProviderRouter();
module.exports = { providerRouter, ProviderRouter };
