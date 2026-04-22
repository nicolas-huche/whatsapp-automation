import 'dotenv/config';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import { routeMediaToText, extractCustomerPhone } from './services/media-router.js';
import { toPublicError } from './errors.js';

const app = Fastify({
  logger: false,
  bodyLimit: Number(process.env.BODY_LIMIT_BYTES || 25 * 1024 * 1024)
});

await app.register(cors, {
  origin: true
});

app.setErrorHandler((error, request, reply) => {
  const publicError = toPublicError(error);
  console.error('[erro]', {
    route: request.url,
    message: error.message,
    details: error.details
  });

  reply.status(publicError.statusCode).send(publicError);
});

app.get('/health', async () => ({
  status: 'ok',
  service: 'whatsapp-message-interpreter',
  timestamp: new Date().toISOString(),
  uptime_seconds: Math.round(process.uptime())
}));

async function handleWebhookMessages(request, reply) {
  const payload = request.body;
  const receivedAt = new Date().toISOString();

  console.log('[webhook] mensagem recebida', {
    receivedAt,
    event: payload?.event,
    instance: payload?.instance,
    messageId: payload?.data?.key?.id,
    customerPhone: extractCustomerPhone(payload)
  });

  const mediaResult = await routeMediaToText(payload);
  const interpretedMessage = {
    type: mediaResult.type,
    customer_phone: mediaResult.customerPhone,
    text: mediaResult.text,
    received_at: receivedAt
  };

  console.log('[media] texto interpretado', interpretedMessage);

  reply.send(interpretedMessage);
}

app.post('/webhook/messages', handleWebhookMessages);
app.post('/webhook/messages-upsert', handleWebhookMessages);

const port = Number(process.env.PORT || 3000);
const host = process.env.HOST || '0.0.0.0';

try {
  await app.listen({ port, host });
  console.log(`[server] ouvindo em http://${host}:${port}`);
} catch (error) {
  console.error('[server] falha ao iniciar', error);
  process.exit(1);
}
