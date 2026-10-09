import { ProductionEventPayload, EventType, EventStatus, SubmissionResult } from '../../shared/contracts';
import { ZodError, z } from 'zod';

// Zod schema for raw payload validation
const eventSchema = z.object({
  source_id: z.string().min(1, { message: 'source_id required' }).trim(),
  event_id: z.string().min(1, { message: 'event_id required' }).trim(),
  type: z.enum(['COUNT', 'VOID']),
  quantity: z.number().int().positive().optional(),
  target_event_id: z.string().optional(),
  event_time: z.string().refine((val) => !isNaN(Date.parse(val)), { message: 'invalid ISO date' })
});

/**
 * Normalizes payload: trims strings, ensures UTC ISO for event_time.
 */
function normalize(payload: ProductionEventPayload): ProductionEventPayload {
  // Trim string fields
  const trimmed = {
    source_id: payload.source_id.trim(),
    event_id: payload.event_id.trim(),
    type: payload.type,
    quantity: payload.quantity ?? null,
    target_event_id: payload.target_event_id ? payload.target_event_id.trim() : null,
    // Convert to UTC ISO string
    event_time: new Date(payload.event_time).toISOString()
  } as ProductionEventPayload;
  return trimmed;
}

/**
 * Validate raw input (any) and return either a normalized payload or a rejection reason.
 */
export function validateEvent(raw: any):
  | { ok: true; value: ProductionEventPayload }
  | { ok: false; reason: string } {
  const MAX_COUNT_QUANTITY = 500;
  try {
    const parsed = eventSchema.parse(raw);
    const normalized = normalize(parsed as ProductionEventPayload);
    // Additional logical checks
    if (normalized.type === 'COUNT') {
      if (
        normalized.quantity == null ||
        !Number.isInteger(normalized.quantity) ||
        normalized.quantity < 1 ||
        normalized.quantity > MAX_COUNT_QUANTITY
      ) {
        return { ok: false, reason: `quantity must be between 1 and ${MAX_COUNT_QUANTITY}` };
      }
      if (normalized.target_event_id) {
        return { ok: false, reason: 'COUNT must not include target_event_id' };
      }
    } else if (normalized.type === 'VOID') {
      if (!normalized.target_event_id) {
        return { ok: false, reason: 'VOID must include target_event_id' };
      }
      if (normalized.quantity != null) {
        return { ok: false, reason: 'VOID must not include quantity' };
      }
    }
    return { ok: true, value: normalized };
  } catch (e) {
    if (e instanceof ZodError) {
      return { ok: false, reason: e.errors.map((err) => err.message).join('; ') };
    }
    return { ok: false, reason: 'Invalid payload' };
  }
}

/**
 * Classifies a validated payload against an existing record.
 * Returns status and optional reason.
 */
export async function classifyEvent(
  client: any,
  payload: ProductionEventPayload
): Promise<{ status: EventStatus; reason?: string }> {
  // Look for existing event with same event_id
  const { rows } = await client.query(
    `SELECT * FROM production_events WHERE event_id = $1`,
    [payload.event_id]
  );
  if (rows.length === 0) {
    // No prior event – proceed to ACCEPTED (or PENDING_REFERENCE for VOID)
    return { status: 'ACCEPTED' };
  }

  const existing = rows[0];
  // Normalise existing payload for comparison
  const existingNormalized = {
    source_id: existing.source_id.trim(),
    event_id: existing.event_id.trim(),
    type: existing.type as EventType,
    quantity: existing.quantity,
    target_event_id: existing.target_event_id?.trim() ?? null,
    event_time: new Date(existing.event_time).toISOString()
  } as ProductionEventPayload;

  const isEqual =
    existingNormalized.source_id === payload.source_id &&
    existingNormalized.type === payload.type &&
    existingNormalized.quantity === payload.quantity &&
    existingNormalized.target_event_id === payload.target_event_id &&
    existingNormalized.event_time === payload.event_time;

  if (isEqual) {
    return { status: 'DUPLICATE' };
  }
  // Conflict – same event_id but different data
  return { status: 'CONFLICT', reason: 'Different payload for same event_id' };
}
