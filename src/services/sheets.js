import { createSign } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { AppError } from '../errors.js';

const SCOPES = 'https://www.googleapis.com/auth/spreadsheets';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';

let cachedCredentials = null;
let cachedToken = null;

function loadCredentials() {
  if (cachedCredentials) return cachedCredentials;

  const raw = process.env.GOOGLE_SERVICE_ACCOUNT_KEY?.trim();

  if (!raw) {
    throw new AppError('GOOGLE_SERVICE_ACCOUNT_KEY nao configurada para Google Sheets.', 500);
  }

  let json;

  if (raw.startsWith('{')) {
    try {
      json = JSON.parse(raw);
    } catch (error) {
      throw new AppError('GOOGLE_SERVICE_ACCOUNT_KEY contem JSON invalido.', 500, error.message);
    }
  } else {
    try {
      json = JSON.parse(readFileSync(raw, 'utf8'));
    } catch (error) {
      throw new AppError('Falha ao ler arquivo de service account do Google.', 500, error.message);
    }
  }

  if (!json.client_email || !json.private_key) {
    throw new AppError('Service account do Google sem client_email ou private_key.', 500);
  }

  cachedCredentials = {
    clientEmail: json.client_email,
    privateKey: json.private_key.replace(/\\n/g, '\n')
  };

  return cachedCredentials;
}

function base64url(input) {
  const buffer = Buffer.isBuffer(input) ? input : Buffer.from(input);
  return buffer.toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
}

function signJwt(clientEmail, privateKey) {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: 'RS256', typ: 'JWT' };
  const claim = {
    iss: clientEmail,
    scope: SCOPES,
    aud: TOKEN_URL,
    iat: now,
    exp: now + 3600
  };

  const input = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(claim))}`;
  const signer = createSign('RSA-SHA256');
  signer.update(input);
  signer.end();
  const signature = signer.sign(privateKey);

  return `${input}.${base64url(signature)}`;
}

async function getAccessToken() {
  if (cachedToken && cachedToken.expiresAt - 60_000 > Date.now()) {
    return cachedToken.token;
  }

  const { clientEmail, privateKey } = loadCredentials();
  const assertion = signJwt(clientEmail, privateKey);

  const response = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion
    })
  });

  const body = await response.json().catch(() => null);

  if (!response.ok || !body?.access_token) {
    throw new AppError('Falha ao obter access token do Google.', 502, {
      status: response.status,
      body
    });
  }

  cachedToken = {
    token: body.access_token,
    expiresAt: Date.now() + Number(body.expires_in || 3600) * 1000
  };

  return cachedToken.token;
}

function sheetId() {
  const id = process.env.GOOGLE_SHEETS_ID?.trim();
  if (!id) {
    throw new AppError('GOOGLE_SHEETS_ID nao configurada.', 500);
  }
  return id;
}

function sheetRange() {
  return process.env.GOOGLE_SHEETS_RANGE?.trim() || 'Pedidos!A:J';
}

function formatTimestamp(date = new Date()) {
  return date.toISOString();
}

export function generateOrderId() {
  const now = new Date();
  const stamp = now.toISOString().replace(/[-:T.Z]/g, '').slice(0, 14);
  const rand = Math.random().toString(36).slice(2, 6).toUpperCase();
  return `P-${stamp}-${rand}`;
}

function itemRows({ orderId, timestamp, customerPhone, customerName, items }) {
  return items.map((item) => [
    timestamp,
    orderId,
    customerPhone || '',
    customerName || '',
    item.product_name || item.product || '',
    item.quantity ?? '',
    item.unit || '',
    '',
    '',
    ''
  ]);
}

export async function appendOrderToSheet({ order, customerPhone, customerName, orderId }) {
  const id = orderId || generateOrderId();
  const token = await getAccessToken();
  const range = sheetRange();
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(sheetId())}/values/${encodeURIComponent(range)}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`;

  const values = itemRows({
    orderId: id,
    timestamp: formatTimestamp(),
    customerPhone,
    customerName,
    items: order?.items || []
  });

  if (!values.length) {
    throw new AppError('Pedido sem itens para adicionar na planilha.', 422);
  }

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${token}`
    },
    body: JSON.stringify({ values })
  });

  const body = await response.json().catch(() => null);

  if (!response.ok) {
    throw new AppError('Falha ao adicionar pedido na planilha do Google.', 502, {
      status: response.status,
      body
    });
  }

  return {
    orderId: id,
    updatedRange: body?.updates?.updatedRange,
    updatedRows: body?.updates?.updatedRows
  };
}
