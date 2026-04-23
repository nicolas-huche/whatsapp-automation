import { toFile } from 'openai';
import { AppError } from '../errors.js';
import { getOpenAIClient } from './openai-client.js';

function mimeForAudio(mimeType) {
  const normalized = (mimeType ?? '').toLowerCase();

  if (normalized.includes('ogg') || normalized.includes('opus')) return 'audio/ogg';
  if (normalized.includes('mpeg')) return 'audio/mpeg';
  if (normalized.includes('mp4')) return 'audio/mp4';
  if (normalized.includes('webm')) return 'audio/webm';
  if (normalized.includes('wav')) return 'audio/wav';
  if (normalized.includes('flac')) return 'audio/flac';

  return 'audio/ogg'; // WhatsApp default
}

function extForMime(mimeType) {
  const normalized = (mimeType ?? '').toLowerCase();

  if (normalized.includes('mpeg')) return 'mp3';
  if (normalized.includes('mp4')) return 'mp4';
  if (normalized.includes('webm')) return 'webm';
  if (normalized.includes('wav')) return 'wav';
  if (normalized.includes('flac')) return 'flac';

  return 'ogg';
}

export async function transcribeAudio(media) {
  const model = process.env.OPENAI_WHISPER_MODEL || 'whisper-1';
  const mime = mimeForAudio(media.mimeType);
  const ext = extForMime(media.mimeType);

  try {
    const file = await toFile(media.buffer, `audio.${ext}`, { type: mime });

    console.log('[audio] enviando para Whisper', {
      originalMime: media.mimeType,
      forcedMime: mime,
      filename: `audio.${ext}`,
      bufferSize: media.buffer.length
    });

    const transcription = await getOpenAIClient().audio.transcriptions.create({
      file,
      model,
      language: 'pt'
    });

    const text = transcription.text?.trim();

    if (!text) {
      throw new AppError('Whisper nao retornou texto para o audio recebido.', 422);
    }

    return text;
  } catch (error) {
    if (error instanceof AppError) {
      throw error;
    }

    throw new AppError('Falha ao transcrever audio com Whisper.', 502, error.message);
  }
}