import { PoolClient } from 'pg';
import { withTransaction } from '../../shared/db';
import { lockEventForAck, markAcknowledged } from './repository';
import { domainEventBus } from '../../shared/domain_events';

/**
 * Acknowledge a list of COUNT event IDs.
 * Returns per‑ID result preserving input order.
 */
export async function acknowledgeEvents(eventIds: string[]) {
  const results: Array<{ event_id: string; status: string; reason?: string }> = [];
  const domainEvents: Array<{ type: string; payload: any }> = [];

  await withTransaction(async (client: PoolClient) => {
    for (const id of eventIds) {
      const row = await lockEventForAck(client, id);
      if (!row) {
        results.push({ event_id: id, status: 'NOT_FOUND' });
        continue;
      }
      if (row.type !== 'COUNT') {
        results.push({ event_id: id, status: 'NOT_READY', reason: 'Not a COUNT event' });
        continue;
      }
      if (row.status !== 'ACCEPTED') {
        results.push({ event_id: id, status: 'NOT_READY', reason: `Status ${row.status}` });
        continue;
      }
      if (row.acknowledged_at) {
        results.push({ event_id: id, status: 'ALREADY_ACKED' });
        continue;
      }
      // OK – mark as acked
      await markAcknowledged(client, id);
      results.push({ event_id: id, status: 'ACKED' });
      domainEvents.push({ type: 'EVENT_ACKNOWLEDGED', payload: { event_id: id, acknowledged_at: new Date().toISOString() } });
    }
  });

  // Emit after transaction commit
  for (const ev of domainEvents) {
    // @ts-ignore – generic typing
    domainEventBus.emitEvent(ev.type as any, ev.payload);
  }

  return results;
}
