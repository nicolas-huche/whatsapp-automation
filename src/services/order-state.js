import { getRedis, keyPrefix } from './redis-client.js';

const memoryStates = new Map();

export const ORDER_STATE_STATUS = {
  AWAITING_CLARIFICATION: 'awaiting_clarification',
  AWAITING_CONFIRMATION: 'awaiting_confirmation'
};

function ttlSeconds() {
  const minutes = Number(process.env.ORDER_STATE_TTL_MINUTES || 30);
  return Math.max(1, minutes) * 60;
}

function ttlMs() {
  return ttlSeconds() * 1000;
}

function normalizeKey(customerPhone) {
  const key = String(customerPhone ?? '').replace(/\D/g, '');
  return key || null;
}

function redisKey(key) {
  return `${keyPrefix()}:order-state:${key}`;
}

function isExpired(record) {
  return Date.now() > record.expiresAt;
}

async function readFromRedis(client, key) {
  const raw = await client.get(redisKey(key));
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch (error) {
    console.error('[order-state] JSON invalido no Redis, limpando', { key, error: error.message });
    await client.del(redisKey(key));
    return null;
  }
}

async function writeToRedis(client, key, record) {
  await client.set(redisKey(key), JSON.stringify(record), 'EX', ttlSeconds());
}

export async function getOrderState(customerPhone) {
  const key = normalizeKey(customerPhone);
  if (!key) return null;

  const client = getRedis();

  if (client) {
    return readFromRedis(client, key);
  }

  const record = memoryStates.get(key);
  if (!record) return null;

  if (isExpired(record)) {
    memoryStates.delete(key);
    return null;
  }

  return record;
}

export async function hasPendingOrderState(customerPhone) {
  return Boolean(await getOrderState(customerPhone));
}

export async function saveOrderState(customerPhone, context) {
  const key = normalizeKey(customerPhone);
  if (!key) return null;

  const now = new Date();
  const existing = await getOrderState(customerPhone);

  const record = {
    customerPhone: key,
    status: context.status || existing?.status || ORDER_STATE_STATUS.AWAITING_CLARIFICATION,
    order: context.order,
    pendingQuestions: context.pendingQuestions || [],
    originalText: context.originalText || existing?.originalText || null,
    customerName: context.customerName ?? existing?.customerName ?? null,
    createdAt: existing?.createdAt || now.toISOString(),
    updatedAt: now.toISOString(),
    expiresAt: Date.now() + ttlMs()
  };

  const client = getRedis();

  if (client) {
    await writeToRedis(client, key, record);
  } else {
    memoryStates.set(key, record);
  }

  return record;
}

export async function clearOrderState(customerPhone) {
  const key = normalizeKey(customerPhone);
  if (!key) return false;

  const client = getRedis();

  if (client) {
    const removed = await client.del(redisKey(key));
    return removed > 0;
  }

  return memoryStates.delete(key);
}

export async function purgeExpiredOrderStates() {
  if (getRedis()) return;

  for (const [key, record] of memoryStates.entries()) {
    if (isExpired(record)) {
      memoryStates.delete(key);
    }
  }
}
