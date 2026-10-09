export interface StateSummary {
  net_total: number;
  processed_events: number;
  pending_ack: number;
  unresolved: number;
  duplicates: number;
  conflicts: number;
  rejected_submissions: number;
}

export interface PendingEvent {
  id: number;
  event_id: string;
  source_id: string;
  type: 'COUNT' | 'VOID';
  quantity: number | null;
  target_event_id: string | null;
  event_time: string;
  status: string;
  received_at: string;
  acknowledged_at: string | null;
  void_event_id: string | null;
}

export interface ExceptionItem {
  event_id: string | null;
  source_id: string | null;
  type: string;
  reason: string | null;
  target_event_id?: string | null;
}

export interface MqttStatusResponse {
  connected: boolean;
  candidate_id: string;
  client_id: string;
  last_challenge_id: string | null;
  last_challenge_time: string | null;
  last_response_status: string | null;
  last_error: string | null;
  challenge_counts: {
    completed: number;
    failed: number;
    total: number;
  };
}

export interface EventSubmissionResult {
  event_id: string;
  status: string;
  message: string | null;
}

export interface AckResultItem {
  event_id: string;
  status: string;
  reason?: string;
}
