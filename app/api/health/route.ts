import { getRuntimeMetricsSnapshot } from '@/lib/observability/runtime-metrics';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

type HealthStatus = 'ok' | 'degraded';

function getDatabaseMode() {
  return process.env.SMARTSTORE_MARKETPLACE_STORE?.trim().toLowerCase() ===
    'database';
}

function shouldIncludeMetrics() {
  return process.env.SMARTSTORE_HEALTH_INCLUDE_METRICS === '1';
}

async function isDatabaseAvailable() {
  try {
    const { prisma } = await import('@/lib/db/prisma');
    await prisma.$queryRaw`SELECT 1`;
    return true;
  } catch {
    return false;
  }
}

export async function GET() {
  const startedAt = Date.now();
  const databaseMode = getDatabaseMode();
  const databaseAvailable = !databaseMode || await isDatabaseAvailable();
  const status: HealthStatus = databaseAvailable ? 'ok' : 'degraded';

  return Response.json(
    {
      status,
      checks: { database: databaseAvailable ? 'ok' : 'error' },
      store: databaseMode ? 'database' : 'file',
      uptimeSeconds: Math.round(process.uptime()),
      responseTimeMs: Date.now() - startedAt,
      ...(shouldIncludeMetrics()
        ? { metrics: getRuntimeMetricsSnapshot() }
        : {}),
    },
    {
      status: databaseAvailable ? 200 : 503,
      headers: {
        'Cache-Control': 'no-store, no-cache, must-revalidate',
      },
    },
  );
}
