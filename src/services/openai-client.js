import OpenAI from 'openai';
import { AppError } from '../errors.js';

let client;

export function getOpenAIClient() {
  if (!process.env.OPENAI_API_KEY) {
    throw new AppError('OPENAI_API_KEY nao configurada.', 500);
  }

  if (!client) {
    client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  }

  return client;
}
