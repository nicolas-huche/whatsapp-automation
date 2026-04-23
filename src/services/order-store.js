import { getRedis, keyPrefix } from './redis-client.js';

const memoryPendingPayments = new Map();

function ttlSeconds() {
  const hours = Number(process.env.ORDER_STORE_TTL_HOURS || 72);
  return Math.max(1, hours) * 60 * 60;
}

function ttlMs() {
  return ttlSeconds() * 1000;
}

function redisKey(orderId) {
  return `${keyPrefix()}:pending-payment:${orderId}`;
}

function isExpired(record) {
  return Date.now() > record.expiresAt;
}

async function readFromRedis(client, orderId) {
  const raw = await client.get(redisKey(orderId));
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch (error) {
    console.error('[order-store] JSON invalido no Redis, limpando', { orderId, error: error.message });
    await client.del(redisKey(orderId));
    return null;
  }
}

async function writeToRedis(client, orderId, record) {
  await client.set(redisKey(orderId), JSON.stringify(record), 'EX', ttlSeconds());
}

export async function savePendingPayment(orderId, data) {
  if (!orderId) return null;

  const now = new Date();
  const existing = await getPendingPayment(orderId);
  const record = {
    orderId,
    createdAt: existing?.createdAt || now.toISOString(),
    updatedAt: now.toISOString(),
    expiresAt: Date.now() + ttlMs(),
    ...existing,
    ...data
  };

  const client = getRedis();

  if (client) {
    await writeToRedis(client, orderId, record);
  } else {
    memoryPendingPayments.set(orderId, record);
  }

  return record;
}

export async function getPendingPayment(orderId) {
  if (!orderId) return null;

  const client = getRedis();

  if (client) {
    return readFromRedis(client, orderId);
  }

  const record = memoryPendingPayments.get(orderId);
  if (!record) return null;

  if (isExpired(record)) {
    memoryPendingPayments.delete(orderId);
    return null;
  }

  return record;
}

export async function clearPendingPayment(orderId) {
  if (!orderId) return false;

  const client = getRedis();

  if (client) {
    const removed = await client.del(redisKey(orderId));
    return removed > 0;
  }

  return memoryPendingPayments.delete(orderId);
}

export async function purgeExpiredPendingPayments() {
  if (getRedis()) return;

  for (const [key, record] of memoryPendingPayments.entries()) {
    if (isExpired(record)) {
      memoryPendingPayments.delete(key);
    }
  }
}
