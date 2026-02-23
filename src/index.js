require('dotenv').config();
const { startBot, setMessageHandler, setOnConnected } = require('./whatsapp/client');
const { handleMessage } = require('./whatsapp/listener');
const { getTryPendingReceipts } = require('./payments/webhook');
const { startCronJobs } = require('./cron');
const app = require('./server');

process.on('unhandledRejection', (reason) => {
  console.error('[UNHANDLED REJECTION]', reason);
});

process.on('uncaughtException', (error) => {
  console.error('[UNCAUGHT EXCEPTION]', error);
  if (error.message?.includes('FATAL')) process.exit(1);
});

async function main() {
  console.log('🚀 Starting VendBot...');

  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => {
    console.log(`✅ Server running on port ${PORT}`);
  });

  setMessageHandler(handleMessage);
  setOnConnected(() => getTryPendingReceipts()());

  // Start WhatsApp in background so Koyeb health checks get 200 on /health immediately.
  // If we await startBot(), slow auth/QR can delay "ready" and Koyeb may timeout the deploy.
  startBot().catch((err) => {
    console.error('[WA] startBot error:', err?.message || err);
  });

  startCronJobs();

  console.log('✅ VendBot running. /health is live; WhatsApp is connecting in background.');
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
