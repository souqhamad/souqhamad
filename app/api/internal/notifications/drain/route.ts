import { timingSafeEqual } from 'node:crypto';
import { drainNotificationDeliveries } from '@/lib/push/delivery-jobs';
import { noStoreHeaders } from '@/lib/api/no-store';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

function isAuthorized(request: Request) {
  const token = process.env.SMARTSTORE_NOTIFICATION_PUMP_TOKEN;
  if (!token || !/^[0-9a-f]{64}$/.test(token)) return false;
  const expected = Buffer.from(`Bearer ${token}`);
  const received = Buffer.from(request.headers.get('authorization') ?? '');
  return received.length === expected.length && timingSafeEqual(received, expected);
}

export async function POST(request: Request) {
  if (!isAuthorized(request)) return Response.json({ error: 'worker_auth_required' }, { status: 401, headers: noStoreHeaders });
  try { return Response.json(await drainNotificationDeliveries(10), { headers: noStoreHeaders }); }
  catch { return Response.json({ error: 'notification_delivery_unavailable' }, { status: 503, headers: noStoreHeaders }); }
}
