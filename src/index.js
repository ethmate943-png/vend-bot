require('dotenv').config();
const { startBot, setMessageHandler } = require('./whatsapp/client');
const { handleMessage } = require('./whatsapp/listener');
const { startCronJobs } = require('./cron');
const app = require('./server');

async function main() {
  console.log('🚀 Starting VendBot...');

  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => {
    console.log(`✅ Server running on port ${PORT}`);
  });

  setMessageHandler(handleMessage);
  await startBot();

  startCronJobs();

  console.log('✅ VendBot running. Waiting for messages...');
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
