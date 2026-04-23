import 'dotenv/config';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import {
  runIncomingMessagePipeline,
  runFinalizeOrderPipeline,
  runPaymentWebhookPipeline
} from './services/order-pipeline.js';
import { requireWebhookToken } from './services/auth.js';
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
  service: 'pedidobot',
  timestamp: new Date().toISOString(),
  uptime_seconds: Math.round(process.uptime())
}));

async function handleWebhookMessages(request, reply) {
  const result = await runIncomingMessagePipeline(request.body);
  return reply.send(result);
}

async function handleFinalizeOrder(request, reply) {
  const result = await runFinalizeOrderPipeline(request.body || {});
  return reply.send(result);
}

async function handlePaymentWebhook(request, reply) {
  const result = await runPaymentWebhookPipeline(request.body || {});
  return reply.send(result);
}

app.post('/webhook/messages', handleWebhookMessages);
app.post('/webhook/messages-upsert', handleWebhookMessages);
app.post('/order/finalize', { preHandler: requireWebhookToken }, handleFinalizeOrder);
app.post('/webhook/payment', { preHandler: requireWebhookToken }, handlePaymentWebhook);

const port = Number(process.env.PORT || 3000);
const host = process.env.HOST || '0.0.0.0';

try {
  await app.listen({ port, host });
  console.log(`[server] ouvindo em http://${host}:${port}`);
} catch (error) {
  console.error('[server] falha ao iniciar', error);
  process.exit(1);
}
