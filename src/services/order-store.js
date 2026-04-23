const pendingPayments = new Map();

function ttlMs() {
  const hours = Number(process.env.ORDER_STORE_TTL_HOURS || 72);
  return Math.max(1, hours) * 60 * 60 * 1000;
}

function isExpired(record) {
  return Date.now() > record.expiresAt;
}

export function savePendingPayment(orderId, data) {
  if (!orderId) return null;

  const now = new Date();
  const existing = pendingPayments.get(orderId);
  const record = {
    orderId,
    createdAt: existing?.createdAt || now.toISOString(),
    updatedAt: now.toISOString(),
    expiresAt: Date.now() + ttlMs(),
    ...existing,
    ...data
  };

  pendingPayments.set(orderId, record);
  return record;
}

export function getPendingPayment(orderId) {
  if (!orderId) return null;

  const record = pendingPayments.get(orderId);
  if (!record) return null;

  if (isExpired(record)) {
    pendingPayments.delete(orderId);
    return null;
  }

  return record;
}

export function clearPendingPayment(orderId) {
  if (!orderId) return false;
  return pendingPayments.delete(orderId);
}

export function purgeExpiredPendingPayments() {
  for (const [key, record] of pendingPayments.entries()) {
    if (isExpired(record)) {
      pendingPayments.delete(key);
    }
  }
}
