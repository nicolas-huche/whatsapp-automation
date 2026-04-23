import { AppError } from '../errors.js';

let warnedMissingToken = false;

function configuredToken() {
  return process.env.WEBHOOK_TOKEN?.trim() || '';
}

function extractToken(request) {
  const header = request.headers['x-webhook-token'];
  if (typeof header === 'string' && header.trim()) return header.trim();

  const query = request.query?.token;
  if (typeof query === 'string' && query.trim()) return query.trim();

  return '';
}

export async function requireWebhookToken(request) {
  const expected = configuredToken();

  if (!expected) {
    if (!warnedMissingToken) {
      warnedMissingToken = true;
      console.warn('[auth] WEBHOOK_TOKEN nao configurado — webhooks expostos sem autenticacao.');
    }
    return;
  }

  const received = extractToken(request);

  if (received !== expected) {
    throw new AppError('Token de webhook invalido.', 401);
  }
}
