import { AppError } from '../errors.js';
import { transcribeAudio } from './audio.js';
import { interpretImage } from './image.js';

const TEXT_TYPES = new Set(['text', 'conversation', 'extendedtextmessage']);
const AUDIO_TYPES = new Set(['audio', 'audiomessage', 'ptt']);
const IMAGE_TYPES = new Set(['image', 'imagemessage']);

function normalizeType(value) {
  return String(value ?? '').replace(/[_\s-]/g, '').toLowerCase();
}

function dataFrom(payload) {
  return payload?.data ?? payload ?? {};
}

function messageFrom(payload) {
  const data = dataFrom(payload);
  return data.message ?? payload?.message ?? {};
}

function mediaMessageFrom(message, type) {
  if (type === 'audio') {
    return message.audioMessage ?? message.audio ?? {};
  }

  if (type === 'image') {
    return message.imageMessage ?? message.image ?? {};
  }

  return {};
}

export function detectMessageType(payload) {
  const data = dataFrom(payload);
  const message = messageFrom(payload);
  const rawTypeCandidates = [
    data.messageType,
    data.type,
    payload?.messageType,
    payload?.type,
    data.mediaType,
    payload?.mediaType
  ].map(normalizeType);

  if (rawTypeCandidates.some((type) => TEXT_TYPES.has(type))) return 'text';
  if (rawTypeCandidates.some((type) => AUDIO_TYPES.has(type))) return 'audio';
  if (rawTypeCandidates.some((type) => IMAGE_TYPES.has(type))) return 'image';

  if (message.conversation || message.extendedTextMessage?.text || data.text || payload?.text) return 'text';
  if (message.audioMessage || message.audio) return 'audio';
  if (message.imageMessage || message.image) return 'image';

  throw new AppError('Tipo de mensagem nao suportado. Use text, audio ou image.', 400, {
    messageType: data.messageType ?? payload?.messageType ?? null
  });
}

export function extractCustomerPhone(payload) {
  const data = dataFrom(payload);
  const candidates = [
    data.key?.remoteJid,
    payload?.key?.remoteJid,
    data.remoteJid,
    payload?.remoteJid,
    data.key?.participant,
    payload?.key?.participant,
    payload?.sender,
    data.sender,
    data.from,
    payload?.from
  ].filter(Boolean);

  for (const candidate of candidates) {
    const raw = String(candidate).trim();
    const [beforeAt, suffix = ''] = raw.split('@');
    const normalizedSuffix = suffix.toLowerCase();

    if (normalizedSuffix === 'lid' && beforeAt.trim()) {
      return beforeAt.trim();
    }

    const digits = beforeAt.replace(/\D/g, '');

    if (digits.length >= 10 && digits.length <= 20) {
      return digits;
    }
  }

  return null;
}

export function extractCustomerName(payload) {
  const data = dataFrom(payload);
  const name = [data.pushName, payload?.pushName]
    .find((value) => typeof value === 'string' && value.trim());

  return name?.trim() || null;
}

function extractText(payload) {
  const data = dataFrom(payload);
  const message = messageFrom(payload);

  const text = [
    message.conversation,
    message.extendedTextMessage?.text,
    message.text,
    data.text,
    data.body,
    payload?.text,
    payload?.body
  ].find((value) => typeof value === 'string' && value.trim());

  if (!text) {
    throw new AppError('Mensagem de texto sem conteudo textual.', 422);
  }

  return text.trim();
}

function extractCaption(payload, type) {
  const message = messageFrom(payload);
  const mediaMessage = mediaMessageFrom(message, type);
  return mediaMessage.caption?.trim() || '';
}

function baseUrlFrom(payload) {
  return (payload?.server_url || process.env.EVOLUTION_API_URL || '').replace(/\/+$/, '');
}

function evolutionHeaders(payload, contentType = undefined) {
  const headers = {};
  const apiKey = process.env.EVOLUTION_API_KEY || payload?.apikey;

  if (contentType) {
    headers['content-type'] = contentType;
  }

  if (apiKey) {
    headers.apikey = apiKey;
  }

  return headers;
}

function extractBase64(value) {
  if (typeof value !== 'string' || !value.trim()) return null;

  const trimmed = value.trim();
  const dataUrlMatch = trimmed.match(/^data:([^;]+);base64,(.+)$/i);

  if (dataUrlMatch) {
    return {
      mimeType: dataUrlMatch[1],
      base64: dataUrlMatch[2].replace(/\s/g, '')
    };
  }

  return {
    mimeType: null,
    base64: trimmed.replace(/\s/g, '')
  };
}

function findDeepValueByKey(input, wantedKeys) {
  if (!input || typeof input !== 'object') return null;

  const stack = [input];
  const wanted = new Set(wantedKeys.map((key) => key.toLowerCase()));

  while (stack.length) {
    const current = stack.pop();

    for (const [key, value] of Object.entries(current)) {
      if (wanted.has(key.toLowerCase()) && typeof value === 'string' && value.trim()) {
        return value;
      }

      if (value && typeof value === 'object') {
        stack.push(value);
      }
    }
  }

  return null;
}

function findPayloadBase64(payload, type) {
  const data = dataFrom(payload);
  const message = messageFrom(payload);
  const mediaMessage = mediaMessageFrom(message, type);
  const candidates = [
    mediaMessage.base64,
    message.base64,
    data.base64,
    data.media?.base64,
    payload?.base64,
    payload?.media?.base64
  ];

  for (const candidate of candidates) {
    const parsed = extractBase64(candidate);
    if (parsed) return parsed;
  }

  const deepBase64 = findDeepValueByKey(payload, ['base64', 'fileBase64']);
  return extractBase64(deepBase64);
}

function findPayloadMediaUrl(payload, type) {
  const data = dataFrom(payload);
  const message = messageFrom(payload);
  const mediaMessage = mediaMessageFrom(message, type);
  const candidates = [
    mediaMessage.url,
    mediaMessage.mediaUrl,
    mediaMessage.media_url,
    message.mediaUrl,
    data.mediaUrl,
    data.media_url,
    data.url,
    payload?.mediaUrl,
    payload?.media_url,
    payload?.url
  ];

  return candidates.find((value) => typeof value === 'string' && value.trim())?.trim() ?? null;
}

function mimeTypeFromPayload(payload, type) {
  const data = dataFrom(payload);
  const message = messageFrom(payload);
  const mediaMessage = mediaMessageFrom(message, type);

  return mediaMessage.mimetype || mediaMessage.mime_type || data.mimetype || payload?.mimetype || null;
}

function extensionFromMime(mimeType, type) {
  const normalized = String(mimeType ?? '').toLowerCase();

  if (normalized.includes('jpeg') || normalized.includes('jpg')) return '.jpg';
  if (normalized.includes('png')) return '.png';
  if (normalized.includes('webp')) return '.webp';
  if (normalized.includes('mpeg')) return '.mp3';
  if (normalized.includes('mp4')) return '.mp4';
  if (normalized.includes('webm')) return '.webm';
  if (normalized.includes('ogg') || normalized.includes('opus')) return '.ogg';

  return type === 'image' ? '.jpg' : '.ogg';
}

function filenameFor(type, mimeType) {
  return `whatsapp-${type}${extensionFromMime(mimeType, type)}`;
}

function bufferFromBase64(base64) {
  try {
    return Buffer.from(base64, 'base64');
  } catch {
    throw new AppError('Midia em base64 invalida no payload da Evolution API.', 422);
  }
}

async function fetchMediaUrl(url, payload, type) {
  const baseUrl = baseUrlFrom(payload);

  if (!url.startsWith('http') && !baseUrl) {
    throw new AppError('URL de midia relativa recebida, mas EVOLUTION_API_URL nao esta configurada.', 422);
  }

  const fullUrl = url.startsWith('http') ? url : `${baseUrl}/${url.replace(/^\/+/, '')}`;
  let response;

  try {
    response = await fetch(fullUrl, { headers: evolutionHeaders(payload) });
  } catch (error) {
    throw new AppError('Falha de rede ao baixar midia da Evolution API.', 502, error.message);
  }

  if (!response.ok) {
    throw new AppError('Falha ao baixar midia pela URL informada pela Evolution API.', 502, {
      status: response.status,
      url: fullUrl
    });
  }

  const mimeType = response.headers.get('content-type') || mimeTypeFromPayload(payload, type);
  const buffer = Buffer.from(await response.arrayBuffer());

  return {
    buffer,
    mimeType,
    filename: filenameFor(type, mimeType)
  };
}

function parseEvolutionBase64Response(rawText) {
  if (!rawText?.trim()) return null;

  try {
    const json = JSON.parse(rawText);
    const base64Value = findDeepValueByKey(json, ['base64', 'fileBase64']);
    const parsed = extractBase64(base64Value);

    if (!parsed) return null;

    const mimeType = findDeepValueByKey(json, ['mimetype', 'mimeType', 'mime_type']) || parsed.mimeType;

    return {
      base64: parsed.base64,
      mimeType
    };
  } catch {
    return extractBase64(rawText);
  }
}

async function fetchEvolutionBase64(payload, type) {
  const data = dataFrom(payload);
  const baseUrl = baseUrlFrom(payload);
  const instance = payload?.instance || data.instance || process.env.EVOLUTION_INSTANCE;
  const messageId = data.key?.id || payload?.key?.id || data.id || payload?.id;

  if (!baseUrl || !instance || !messageId) {
    throw new AppError('Nao foi possivel localizar a midia no payload e faltam dados para baixar pela Evolution API.', 422, {
      hasEvolutionUrl: Boolean(baseUrl),
      hasInstance: Boolean(instance),
      hasMessageId: Boolean(messageId)
    });
  }

  const response = await fetch(`${baseUrl}/chat/getBase64FromMediaMessage/${encodeURIComponent(instance)}`, {
    method: 'POST',
    headers: evolutionHeaders(payload, 'application/json'),
    body: JSON.stringify({
      message: {
        key: {
          id: messageId
        }
      },
      convertToMp4: false
    })
  });

  if (!response.ok) {
    throw new AppError('Falha ao baixar midia pela Evolution API.', 502, {
      status: response.status,
      messageId
    });
  }

  const parsed = parseEvolutionBase64Response(await response.text());

  if (!parsed?.base64) {
    throw new AppError('Evolution API nao retornou base64 da midia.', 502, { messageId });
  }

  const mimeType = parsed.mimeType || mimeTypeFromPayload(payload, type);

  return {
    buffer: bufferFromBase64(parsed.base64),
    mimeType,
    filename: filenameFor(type, mimeType)
  };
}

async function downloadMedia(payload, type) {
  const fromPayload = findPayloadBase64(payload, type);

  if (fromPayload?.base64) {
    const mimeType = fromPayload.mimeType || mimeTypeFromPayload(payload, type);

    return {
      buffer: bufferFromBase64(fromPayload.base64),
      mimeType,
      filename: filenameFor(type, mimeType)
    };
  }

  const mediaUrl = findPayloadMediaUrl(payload, type);

  // URLs do CDN do WhatsApp são criptografadas, não adianta baixar direto
  if (mediaUrl && !mediaUrl.includes('whatsapp.net')) {
    try {
      return await fetchMediaUrl(mediaUrl, payload, type);
    } catch (error) {
      console.log('[media] URL direta falhou, tentando via Evolution API...', error.message);
    }
  }

  const result = await fetchEvolutionBase64(payload, type);

  // Se o mime type veio genérico, usa o do payload original
  if (!result.mimeType || result.mimeType === 'application/octet-stream') {
    result.mimeType = mimeTypeFromPayload(payload, type) || result.mimeType;
  }

  return result;
}

export async function routeMediaToText(payload) {
  const type = detectMessageType(payload);
  const customerPhone = extractCustomerPhone(payload);

  if (type === 'text') {
    return {
      type,
      customerPhone,
      text: extractText(payload)
    };
  }

  const media = await downloadMedia(payload, type);

  if (!media.buffer.length) {
    throw new AppError('Midia recebida sem conteudo.', 422);
  }

  if (type === 'audio') {
    return {
      type,
      customerPhone,
      text: await transcribeAudio(media)
    };
  }

  if (type === 'image') {
    return {
      type,
      customerPhone,
      text: await interpretImage(media, extractCaption(payload, type))
    };
  }

  throw new AppError('Tipo de mensagem nao suportado.', 400, { type });
}
