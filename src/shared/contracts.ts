// Shared types and data contracts across modules

export type EventType = 'COUNT' | 'VOID';

export type EventStatus = 'ACCEPTED' | 'PENDING_REFERENCE' | 'DUPLICATE' | 'CONFLICT' | 'REJECTED';

export interface ProductionEventPayload {
  source_id: string;
  event_id: string;
  type: EventType;
  quantity?: number | null;
  target_event_id?: string | null;
  event_time: string;
}

export interface ProductionEventRecord {
  id: number;
  event_id: string;
  source_id: string;
  type: EventType;
  quantity: number | null;
  target_event_id: string | null;
  event_time: string;
  status: EventStatus;
  received_at: string;
  acknowledged_at: string | null;
  void_event_id: string | null;
}

export interface SubmissionResult {
  event_id: string;
  status: EventStatus;
  reason?: string;
  received_at: string;
}

export interface ProductionSourceRecord {
  source_id: string;
  display_name: string;
  created_at: string;
}
