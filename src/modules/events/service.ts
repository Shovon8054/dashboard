import { PoolClient } from 'pg';
import {
  ProductionEventPayload,
  EventStatus,
  SubmissionResult,
} from '../../shared/contracts';
import { validateEvent } from './validation';
import {
  insertEvent,
  insertSubmissionAttempt,
  findEventById,
  getPendingVoids,
  resolvePendingVoid,
  rejectPendingVoid,
} from './repository';
import { withTransaction } from '../../shared/db';
import { domainEventBus } from '../../shared/domain_events';

export async function processEvent(raw: any): Promise<SubmissionResult> {
  const now = new Date().toISOString();

  // 1. Structural validation
  const validation = validateEvent(raw);
  if (!validation.ok) {
    await withTransaction(async (client) => {
      await insertSubmissionAttempt(
        client,
        typeof raw?.source_id === 'string' ? raw.source_id : null,
        typeof raw?.event_id === 'string' ? raw.event_id : null,
        raw,
        'REJECTED',
        validation.reason
      );
    });
    return {
      event_id: typeof raw?.event_id === 'string' ? raw.event_id : 'unknown',
      status: 'REJECTED',
      reason: validation.reason,
      received_at: now,
    };
  }

  const payload = validation.value;
  const domainEventsToEmit: Array<{ type: 'EVENT_ACCEPTED' | 'VOID_RESOLVED'; payload: any }> = [];

  const result = await withTransaction(async (client: PoolClient) => {
    // Check if event_id already exists (duplicate or conflict)
    const existing = await findEventById(client, payload.event_id, true);
    if (existing) {
      const existingNormalized = {
        source_id: existing.source_id.trim(),
        event_id: existing.event_id.trim(),
        type: existing.type,
        quantity: existing.quantity != null ? Number(existing.quantity) : null,
        target_event_id: existing.target_event_id ? existing.target_event_id.trim() : null,
        event_time: new Date(existing.event_time).toISOString(),
      };

      const currentNormalized = {
        source_id: payload.source_id.trim(),
        event_id: payload.event_id.trim(),
        type: payload.type,
        quantity: payload.quantity != null ? Number(payload.quantity) : null,
        target_event_id: payload.target_event_id ? payload.target_event_id.trim() : null,
        event_time: new Date(payload.event_time).toISOString(),
      };

      const isDuplicate =
        existingNormalized.source_id === currentNormalized.source_id &&
        existingNormalized.type === currentNormalized.type &&
        existingNormalized.quantity === currentNormalized.quantity &&
        existingNormalized.target_event_id === currentNormalized.target_event_id &&
        existingNormalized.event_time === currentNormalized.event_time;

      if (isDuplicate) {
        await insertSubmissionAttempt(
          client,
          payload.source_id,
          payload.event_id,
          raw,
          'DUPLICATE'
        );
        return {
          event_id: payload.event_id,
          status: 'DUPLICATE' as EventStatus,
          received_at: now,
        };
      } else {
        await insertSubmissionAttempt(
          client,
          payload.source_id,
          payload.event_id,
          raw,
          'CONFLICT',
          'Payload differs from existing event record'
        );
        return {
          event_id: payload.event_id,
          status: 'CONFLICT' as EventStatus,
          reason: 'Payload differs from existing event record',
          received_at: now,
        };
      }
    }

    // Process new event
    if (payload.type === 'COUNT') {
      // 1. Insert COUNT
      const countRow = await insertEvent(client, payload, 'ACCEPTED');

      domainEventsToEmit.push({
        type: 'EVENT_ACCEPTED',
        payload: {
          event_id: payload.event_id,
          source_id: payload.source_id,
          type: 'COUNT',
          quantity: payload.quantity ?? null,
        },
      });

      // 2. Check for pending VOIDs targeting this COUNT
      const pendingVoids = await getPendingVoids(client, payload.event_id);
      if (pendingVoids.length > 0) {
        let winningVoid: any = null;

        for (const pv of pendingVoids) {
          if (!winningVoid && pv.source_id === payload.source_id) {
            // First valid VOID wins
            winningVoid = pv;
            await resolvePendingVoid(client, pv.id, pv.event_id, countRow.id);

            domainEventsToEmit.push({
              type: 'VOID_RESOLVED',
              payload: {
                void_event_id: pv.event_id,
                target_event_id: payload.event_id,
                source_id: payload.source_id,
              },
            });
          } else {
            // Subsequent pending VOIDs or mismatched source_id are rejected
            await rejectPendingVoid(client, pv.id);
            await insertSubmissionAttempt(
              client,
              pv.source_id,
              pv.event_id,
              { event_id: pv.event_id, target_event_id: payload.event_id },
              'REJECTED',
              pv.source_id !== payload.source_id
                ? 'source_id mismatch with target COUNT'
                : 'COUNT already reversed by an earlier pending VOID'
            );
          }
        }
      }

      await insertSubmissionAttempt(
        client,
        payload.source_id,
        payload.event_id,
        raw,
        'ACCEPTED'
      );

      return {
        event_id: payload.event_id,
        status: 'ACCEPTED' as EventStatus,
        received_at: now,
      };
    } else {
      // VOID event processing
      const target = await findEventById(client, payload.target_event_id!, true);

      if (!target) {
        // Target COUNT missing -> store as PENDING_REFERENCE
        await insertEvent(client, payload, 'PENDING_REFERENCE');
        await insertSubmissionAttempt(
          client,
          payload.source_id,
          payload.event_id,
          raw,
          'PENDING_REFERENCE'
        );
        return {
          event_id: payload.event_id,
          status: 'PENDING_REFERENCE' as EventStatus,
          reason: 'Target event not found, saved as pending reference',
          received_at: now,
        };
      }

      // Target exists: validate rules
      if (target.type !== 'COUNT') {
        await insertSubmissionAttempt(
          client,
          payload.source_id,
          payload.event_id,
          raw,
          'REJECTED',
          'Target event is not a COUNT'
        );
        return {
          event_id: payload.event_id,
          status: 'REJECTED' as EventStatus,
          reason: 'Target event is not a COUNT',
          received_at: now,
        };
      }

      if (target.source_id !== payload.source_id) {
        await insertSubmissionAttempt(
          client,
          payload.source_id,
          payload.event_id,
          raw,
          'REJECTED',
          'source_id does not match target COUNT source_id'
        );
        return {
          event_id: payload.event_id,
          status: 'REJECTED' as EventStatus,
          reason: 'source_id does not match target COUNT source_id',
          received_at: now,
        };
      }

      if (target.void_event_id) {
        await insertSubmissionAttempt(
          client,
          payload.source_id,
          payload.event_id,
          raw,
          'REJECTED',
          'Target COUNT has already been reversed'
        );
        return {
          event_id: payload.event_id,
          status: 'REJECTED' as EventStatus,
          reason: 'Target COUNT has already been reversed',
          received_at: now,
        };
      }

      // Valid VOID -> insert as ACCEPTED and auto-acknowledge
      const voidRow = await insertEvent(
        client,
        payload,
        'ACCEPTED',
        null,
        new Date()
      );

      // Link COUNT to this VOID
      await client.query(
        `UPDATE production_events SET void_event_id = $1 WHERE id = $2`,
        [voidRow.event_id, target.id]
      );

      await insertSubmissionAttempt(
        client,
        payload.source_id,
        payload.event_id,
        raw,
        'ACCEPTED'
      );

      domainEventsToEmit.push({
        type: 'EVENT_ACCEPTED',
        payload: {
          event_id: payload.event_id,
          source_id: payload.source_id,
          type: 'VOID',
          quantity: null,
        },
      });

      domainEventsToEmit.push({
        type: 'VOID_RESOLVED',
        payload: {
          void_event_id: payload.event_id,
          target_event_id: payload.target_event_id!,
          source_id: payload.source_id,
        },
      });

      return {
        event_id: payload.event_id,
        status: 'ACCEPTED' as EventStatus,
        received_at: now,
      };
    }
  });

  // Emit domain events strictly post-commit
  for (const de of domainEventsToEmit) {
    domainEventBus.emitEvent(de.type, de.payload);
  }

  return result;
}

export async function processBatch(items: any[]): Promise<SubmissionResult[]> {
  const results: SubmissionResult[] = [];
  for (const item of items) {
    const res = await processEvent(item);
    results.push(res);
  }
  return results;
}
