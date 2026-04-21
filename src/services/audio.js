import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { unlink, writeFile } from 'node:fs/promises';
import OpenAI from 'openai';
import { AppError } from '../errors.js';

let openaiClient;

function getOpenAIClient() {
  if (!process.env.OPENAI_API_KEY) {
    throw new AppError('OPENAI_API_KEY nao configurada para transcrever audio.', 500);
  }

  if (!openaiClient) {
    openaiClient = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  }

  return openaiClient;
}

function extensionFromMime(mimeType) {
  const normalized = (mimeType ?? '').toLowerCase();

  if (normalized.includes('mpeg')) return '.mp3';
  if (normalized.includes('mp4')) return '.mp4';
  if (normalized.includes('webm')) return '.webm';
  if (normalized.includes('wav')) return '.wav';
  if (normalized.includes('aac')) return '.aac';
  if (normalized.includes('flac')) return '.flac';
  if (normalized.includes('ogg') || normalized.includes('opus')) return '.ogg';

  return '.ogg';
}

export async function transcribeAudio(media) {
  const model = process.env.OPENAI_WHISPER_MODEL || 'whisper-1';
  const tempPath = path.join(os.tmpdir(), `whatsapp-audio-${randomUUID()}${extensionFromMime(media.mimeType)}`);

  try {
    await writeFile(tempPath, media.buffer);

    const transcription = await getOpenAIClient().audio.transcriptions.create({
      file: fs.createReadStream(tempPath),
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
  } finally {
    await unlink(tempPath).catch(() => {});
  }
}
