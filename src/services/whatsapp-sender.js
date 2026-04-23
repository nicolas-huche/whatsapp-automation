import { AppError } from '../errors.js';

function baseUrl() {
  return (process.env.EVOLUTION_API_URL || '').replace(/\/+$/, '');
}

function headers() {
  const output = {
    'content-type': 'application/json'
  };

  if (process.env.EVOLUTION_API_KEY) {
    output.apikey = process.env.EVOLUTION_API_KEY;
  }

  return output;
}

function normalizeRecipient(to) {
  const raw = String(to ?? '').trim();
  const lower = raw.toLowerCase();
  const beforeAt = raw.split('@')[0];
  const digits = beforeAt.replace(/\D/g, '');

  if (lower.includes('@lid')) {
    return raw;
  }

  if (digits.length >= 15) {
    return `${digits}@lid`;
  }

  return digits;
}

async function parseResponse(response) {
  const rawText = await response.text();

  if (!rawText.trim()) return null;

  try {
    return JSON.parse(rawText);
  } catch {
    return rawText;
  }
}

export async function sendTextMessage({ to, text, instance = process.env.EVOLUTION_INSTANCE }) {
  const url = baseUrl();
  const number = normalizeRecipient(to);

  if (!url) {
    throw new AppError('EVOLUTION_API_URL nao configurada para enviar mensagem.', 500);
  }

  if (!instance) {
    throw new AppError('EVOLUTION_INSTANCE nao configurada para enviar mensagem.', 500);
  }

  if (!number) {
    throw new AppError('Telefone do destinatario nao informado para envio.', 422);
  }

  if (!text?.trim()) {
    throw new AppError('Texto da mensagem nao informado para envio.', 422);
  }

  let response;

  try {
    response = await fetch(`${url}/message/sendText/${encodeURIComponent(instance)}`, {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify({
        number,
        textMessage: {
          text: text.trim()
        }
      })
    });
  } catch (error) {
    throw new AppError('Falha de rede ao enviar mensagem pela Evolution API.', 502, error.message);
  }

  const body = await parseResponse(response);

  if (!response.ok) {
    throw new AppError('Evolution API rejeitou o envio da mensagem.', 502, {
      status: response.status,
      body
    });
  }

  return body;
}
