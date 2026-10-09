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
  acceptVoid,
  rejectVoid,
  insertPendingVoid,
} from './repository';
import { withTransaction } from '../../shared/db';
import { domainEventBus } from '../../shared/domain_events';

/**
 * Core entry point used by both REST controllers and the MQTT worker.
 * Returns a SubmissionResult for each processed event.
 */
export async function processEvent(raw: any): Promise<SubmissionResult> {
  const now = new Date().toISOString();

  const validation = validateEvent(raw);
  if (!validation.ok) {
    // rejected payload – still log the attempt
    await withTransaction(async (client) => {
      await insertSubmissionAttempt(
        client,
        raw.source_id ?? null,
        raw.event_id ?? null,
        raw,
        'REJECTED',
        validation.reason
      );
    });
    return {
      event_id: raw.event_id ?? 'unknown',
      status: 'REJECTED',
      reason: validation.reason,
      received_at: now,
    };
  }

  const payload = validation.value;

  // Transaction ensures atomic processing & logging
  const domainEvents: Array<{ type: string; payload: any }> = [];

  const result = await withTransaction(async (client: PoolClient) => {
    // Classification against existing records (duplicate / conflict)
    const { rows } = await client.query(
      `SELECT * FROM production_events WHERE event_id = $1`,
      [payload.event_id]
    );
    if (rows.length > 0) {
      const existing = rows[0];
      const existingNorm = {
        source_id: existing.source_id.trim(),
        event_id: existing.event_id.trim(),
        type: existing.type as ProductionEventPayload['type'],
        quantity: existing.quantity,
        target_event_id: existing.target_event_id?.trim() ?? null,
        event_time: new Date(existing.event_time).toISOString(),
      } as ProductionEventPayload;

      const isEqual =
        existingNorm.source_id === payload.source_id &&
        existingNorm.type === payload.type &&
        existingNorm.quantity === payload.quantity &&
        existingNorm.target_event_id === payload.target_event_id &&
        existingNorm.event_time === payload.event_time;

      if (isEqual) {
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
          'Payload differs from existing event'
        );
        return {
          event_id: payload.event_id,
          status: 'CONFLICT' as EventStatus,
          reason: 'Different payload for same event_id',
          received_at: now,
        };
      }
    }

    // New event – process according to type
    if (payload.type === 'COUNT') {
      const inserted = await processCount(client, payload);
      // After a COUNT is stored we may need to resolve pending VOIDs
      const pending = await getPendingVoids(client, payload.event_id);
      if (pending.length > 0) {
        // Accept the first pending VOID, reject the rest
        const [first, ...rest] = pending;
        const countRow = await findEventById(client, payload.event_id, true);
        await acceptVoid(client, first, countRow);
        domainEvents.push({ type: 'EVENT_ACCEPTED', payload: { event_id: payload.event_id, source_id: payload.source_id, type: 'COUNT', quantity: payload.quantity } });
        domainEvents.push({ type: 'VOID_RESOLVED', payload: { void_event_id: first.event_id, target_event_id: payload.event_id, source_id: payload.source_id } });
        for (const other of rest) {
          await rejectVoid(client, other, 'Another VOID already resolved this COUNT');
        }
      } else {
        domainEvents.push({ type: 'EVENT_ACCEPTED', payload: { event_id: payload.event_id, source_id: payload.source_id, type: 'COUNT', quantity: payload.quantity } });
      }
      await insertSubmissionAttempt(
        client,
        payload.source_id,
        payload.event_id,
        raw,
        'ACCEPTED'
      );
      return { event_id: payload.event_id, status: 'ACCEPTED' as EventStatus, received_at: now };
    } else {
      // VOID handling
      const voidResult = await processVoid(client, payload);
      // processVoid already logs submission attempt and pushes domain events
      return voidResult;
    }
  });

  // Emit any domain events after the transaction has committed
  for (const ev of domainEvents) {
    // @ts-ignore – generic typing
    domainEventBus.emitEvent(ev.type as any, ev.payload);
  }

  return result as SubmissionResult;
}

/** Process a COUNT event – simply insert with ACCEPTED status */
async function processCount(client: PoolClient, payload: ProductionEventPayload) {
  await insertEvent(client, payload, 'ACCEPTED');
  return payload;
}

/** Process a VOID event – may become PENDING_REFERENCE or ACCEPTED */
async function processVoid(client: PoolClient, payload: ProductionEventPayload) {
  // Lock target COUNT row if it exists
  const target = await findEventById(client, payload.target_event_id!, true);
  if (!target) {
    // No target yet – store as pending reference
    await insertPendingVoid(client, payload, 'PENDING_REFERENCE');
    await insertSubmissionAttempt(
      client,
      payload.source_id,
      payload.event_id,
      payload,
      'ACCEPTED'
    );
    // No domain events yet; will be emitted when the COUNT arrives
    return { event_id: payload.event_id, status: 'PENDING_REFERENCE' as EventStatus, received_at: new Date().toISOString() };
  }

  // Target exists – enforce business rules
  if (target.type !== 'COUNT') {
    await insertSubmissionAttempt(
      client,
      payload.source_id,
      payload.event_id,
      payload,
      'REJECTED',
      'Target event is not a COUNT'
    );
    return { event_id: payload.event_id, status: 'REJECTED' as EventStatus, reason: 'Target not COUNT', received_at: new Date().toISOString() };
  }

  if (target.source_id !== payload.source_id) {
    await insertSubmissionAttempt(
      client,
      payload.source_id,
      payload.event_id,
      payload,
      'REJECTED',
      'source_id mismatch with target COUNT'
    );
    return { event_id: payload.event_id, status: 'REJECTED' as EventStatus, reason: 'source_id mismatch', received_at: new Date().toISOString() };
  }

  if (target.void_event_id) {
    // COUNT already voided
    await insertSubmissionAttempt(
      client,
      payload.source_id,
      payload.event_id,
      payload,
      'REJECTED',
      'COUNT already voided by another VOID'
    );
    return { event_id: payload.event_id, status: 'REJECTED' as EventStatus, reason: 'COUNT already voided', received_at: new Date().toISOString() };
  }

  // Accept the VOID and update the COUNT
  await acceptVoid(client, payload, target);
  await insertSubmissionAttempt(
    client,
    payload.source_id,
    payload.event_id,
    payload,
    'ACCEPTED'
  );
  // Queue domain events
  (global as any).domainEvents?.push({ type: 'EVENT_ACCEPTED', payload: { event_id: payload.event_id, source_id: payload.source_id, type: 'VOID', quantity: null } });
  (global as any).domainEvents?.push({ type: 'VOID_RESOLVED', payload: { void_event_id: payload.event_id, target_event_id: payload.target_event_id, source_id: payload.source_id } });
  return { event_id: payload.event_id, status: 'ACCEPTED' as EventStatus, received_at: new Date().toISOString() };
}

/**
 * Process a batch of raw event objects while preserving order.
 */
export async function processBatch(items: any[]): Promise<SubmissionResult[]> {
  const results: SubmissionResult[] = [];
  for (const item of items) {
    // Sequential processing guarantees order preservation
    const res = await processEvent(item);
    results.push(res);
  }
  return results;
}
