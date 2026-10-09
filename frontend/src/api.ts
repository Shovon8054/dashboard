import {
  StateSummary,
  PendingEvent,
  ExceptionItem,
  MqttStatusResponse,
  EventSubmissionResult,
  AckResultItem,
} from './types';

const BASE_URL = '/api';

export async function submitEvents(
  payload: any
): Promise<{ results: EventSubmissionResult[] }> {
  const res = await fetch(`${BASE_URL}/events`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: typeof payload === 'string' ? payload : JSON.stringify(payload),
  });

  const data = await res.json();
  if (!res.ok) {
    throw new Error(data.error || 'Failed to submit events');
  }
  return data;
}

export async function getStateSummary(sourceId?: string): Promise<StateSummary> {
  const params = new URLSearchParams({ view: 'summary' });
  if (sourceId && sourceId.trim()) {
    params.set('source_id', sourceId.trim());
  }

  const res = await fetch(`${BASE_URL}/state?${params.toString()}`);
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || 'Failed to load summary');
  }
  return res.json();
}

export async function getPendingEvents(sourceId?: string): Promise<PendingEvent[]> {
  const params = new URLSearchParams({ view: 'pending' });
  if (sourceId && sourceId.trim()) {
    params.set('source_id', sourceId.trim());
  }

  const res = await fetch(`${BASE_URL}/state?${params.toString()}`);
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || 'Failed to load pending events');
  }
  const data = await res.json();
  return data.pending || [];
}

export async function getExceptions(sourceId?: string): Promise<ExceptionItem[]> {
  const params = new URLSearchParams({ view: 'exceptions' });
  if (sourceId && sourceId.trim()) {
    params.set('source_id', sourceId.trim());
  }

  const res = await fetch(`${BASE_URL}/state?${params.toString()}`);
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || 'Failed to load exceptions');
  }
  const data = await res.json();
  return data.exceptions || [];
}

export async function acknowledgeEvents(
  eventIds: string[]
): Promise<{ results: AckResultItem[] }> {
  const res = await fetch(`${BASE_URL}/ack`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ event_ids: eventIds }),
  });

  const data = await res.json();
  if (!res.ok) {
    throw new Error(data.error || 'Failed to acknowledge events');
  }
  return data;
}

export async function getMqttStatus(): Promise<MqttStatusResponse> {
  const res = await fetch(`${BASE_URL}/mqtt/status`);
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || 'Failed to load MQTT status');
  }
  return res.json();
}
