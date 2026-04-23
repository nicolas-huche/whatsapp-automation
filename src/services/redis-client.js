import Redis from 'ioredis';

let cachedClient = null;
let cachedUrl = null;
let warnedDisabled = false;

export function isRedisEnabled() {
  return Boolean(process.env.REDIS_URL?.trim());
}

export function getRedis() {
  if (!isRedisEnabled()) {
    if (!warnedDisabled) {
      warnedDisabled = true;
      console.warn('[redis] REDIS_URL nao configurado — usando Map em memoria para estado de pedidos.');
    }
    return null;
  }

  const url = process.env.REDIS_URL.trim();

  if (cachedClient && cachedUrl === url) return cachedClient;

  const client = new Redis(url, {
    maxRetriesPerRequest: 3,
    enableReadyCheck: true,
    lazyConnect: false
  });

  client.on('error', (err) => {
    console.error('[redis] erro no cliente', err.message);
  });

  cachedClient = client;
  cachedUrl = url;

  return client;
}

export function keyPrefix() {
  return (process.env.REDIS_KEY_PREFIX || 'pedidobot').replace(/:+$/, '');
}
