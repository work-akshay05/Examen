import { createApp } from './app.js';
import { loadConfig } from './config.js';
import { connectDatabase, disconnectDatabase } from './db.js';
import { hashPassword } from './auth.js';
import { User } from './models/User.js';

let server;
let shuttingDown = false;

async function bootstrapAdmin(config) {
  if (!config.ADMIN_EMAIL || !config.ADMIN_PASSWORD) return;
  if (config.ADMIN_PASSWORD.length < 12) throw new Error('ADMIN_PASSWORD must be at least 12 characters');
  await User.updateOne(
    { email: config.ADMIN_EMAIL.toLowerCase() },
    { $setOnInsert: { name: config.ADMIN_NAME, email: config.ADMIN_EMAIL.toLowerCase(), passwordHash: await hashPassword(config.ADMIN_PASSWORD), role: 'admin' } },
    { upsert: true }
  );
}

async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.info(`${signal} received; shutting down`);
  if (server) await new Promise((resolve) => server.close(resolve));
  await disconnectDatabase();
}

try {
  const config = loadConfig();
  await connectDatabase(config.MONGODB_URI);
  await bootstrapAdmin(config);
  server = createApp(config).listen(config.PORT, () => console.info(`API listening on port ${config.PORT}`));
  process.once('SIGINT', () => shutdown('SIGINT').then(() => process.exit(0)));
  process.once('SIGTERM', () => shutdown('SIGTERM').then(() => process.exit(0)));
} catch (error) {
  console.error(`Startup failed: ${error.message}`);
  process.exit(1);
}
