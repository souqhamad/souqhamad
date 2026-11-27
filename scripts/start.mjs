import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { constants } from 'node:os';
import { startNotificationDeliveryPump } from './notification-delivery-pump.mjs';

const minimumSupportedNodeMajor = 22;
const maximumSupportedNodeMajor = 24;

function getNodeMajorVersion() {
  return Number.parseInt(process.versions.node.split('.')[0] ?? '', 10);
}

function assertSupportedNodeVersion() {
  const nodeMajor = getNodeMajorVersion();

  if (
    Number.isFinite(nodeMajor) &&
    nodeMajor >= minimumSupportedNodeMajor &&
    nodeMajor <= maximumSupportedNodeMajor
  ) {
    return;
  }

  console.error(
    `[startup] Unsupported Node.js ${process.versions.node}. Use Node ${minimumSupportedNodeMajor}.x to ${maximumSupportedNodeMajor}.x.`,
  );
  process.exit(1);
}

function getMarketplaceStoreMode() {
  return (
    process.env.SMARTSTORE_MARKETPLACE_STORE?.trim().toLowerCase() || 'file'
  );
}

function assertProductionEnvironment() {
  if (process.env.NODE_ENV !== 'production') return;

  if (getMarketplaceStoreMode() !== 'database') {
    throw new Error('SMARTSTORE_MARKETPLACE_STORE must be "database" in production.');
  }
  process.env.SMARTSTORE_MARKETPLACE_STORE = 'database';

  const databaseUrl = process.env.DATABASE_URL?.trim();
  let database;
  try {
    database = new URL(databaseUrl);
  } catch {
    // Validation failures must not include the connection string.
  }
  if (!database?.hostname || !['postgresql:', 'postgres:'].includes(database.protocol) || database.pathname.length < 2) {
    throw new Error('DATABASE_URL must identify a PostgreSQL database in production.');
  }
  process.env.DATABASE_URL = databaseUrl;

  const authSecret = process.env.AUTH_SECRET?.trim();
  if (!authSecret || authSecret.length < 32 || /^(?:replace[ _-]|development-only-)/i.test(authSecret)) {
    throw new Error('AUTH_SECRET must contain at least 32 characters and be set to a production value.');
  }
}

function shouldRunDatabaseMigrations() {
  const value = process.env.SMARTSTORE_RUN_DB_MIGRATIONS_ON_START?.trim();
  return value === '1' || value?.toLowerCase() === 'true';
}

function runDatabaseMigrations() {
  return new Promise((resolve, reject) => {
    const migration = spawn(process.execPath, ['node_modules/prisma/build/index.js', 'migrate', 'deploy'], {
      env: process.env,
      stdio: 'inherit',
    });

    migration.on('error', reject);
    migration.on('exit', (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }

      reject(
        new Error(
          signal
            ? `[startup] prisma migrate deploy exited with signal ${signal}.`
            : `[startup] prisma migrate deploy exited with code ${code}.`,
        ),
      );
    });
  });
}

assertSupportedNodeVersion();
process.env.NODE_ENV ||= 'production';
try {
  assertProductionEnvironment();
} catch (error) {
  console.error(`[startup] ${error.message}`);
  process.exit(1);
}

if (shouldRunDatabaseMigrations()) {
  console.log('[startup] applying database migrations...');
  await runDatabaseMigrations();
}

const port = process.env.PORT || '3000';
const shutdownGraceMs = Number.parseInt(
  process.env.SMARTSTORE_SHUTDOWN_GRACE_MS ?? '',
  10,
);
const gracefulShutdownMs = Number.isFinite(shutdownGraceMs)
  ? Math.max(0, shutdownGraceMs)
  : 10_000;

// The supervisor and its Next.js child share a fresh token for notification retries.
const useNotificationPump = getMarketplaceStoreMode() === 'database';
const notificationToken = useNotificationPump ? randomBytes(32).toString('hex') : '';
const stopNotificationPump = startNotificationDeliveryPump({
  port, secret: notificationToken, enabled: useNotificationPump,
});
const child = spawn(
  process.execPath,
  ['node_modules/next/dist/bin/next', 'start', '-H', '0.0.0.0', '-p', port],
  {
    env: { ...process.env, SMARTSTORE_NOTIFICATION_PUMP_TOKEN: notificationToken },
    stdio: 'inherit',
  },
);

let shuttingDown = false;
child.once('exit', stopNotificationPump);
child.once('error', () => {
  stopNotificationPump();
  console.error('[startup] Could not start the Next.js process.');
  process.exit(1);
});

function forwardSignal(signal) {
  if (shuttingDown) {
    return;
  }

  shuttingDown = true;
  stopNotificationPump();
  console.log(`[startup] received ${signal}, shutting down gracefully...`);

  const forceExitTimer = setTimeout(() => {
    console.error('[startup] graceful shutdown timed out, forcing exit.');
    child.kill('SIGKILL');
  }, gracefulShutdownMs);

  forceExitTimer.unref?.();

  child.once('exit', () => clearTimeout(forceExitTimer));
  child.kill(signal);
}

for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => forwardSignal(signal));
}

child.on('exit', (code, signal) => {
  process.exit(signal ? 128 + constants.signals[signal] : (code ?? 1));
});
