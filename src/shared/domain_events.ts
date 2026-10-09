import { EventEmitter } from 'node:events';

export type DomainEventType = 'EVENT_ACCEPTED' | 'VOID_RESOLVED' | 'EVENT_ACKNOWLEDGED';

export interface DomainEventPayloadMap {
  EVENT_ACCEPTED: {
    event_id: string;
    source_id: string;
    type: 'COUNT' | 'VOID';
    quantity: number | null;
  };
  VOID_RESOLVED: {
    void_event_id: string;
    target_event_id: string;
    source_id: string;
  };
  EVENT_ACKNOWLEDGED: {
    event_id: string;
    acknowledged_at: string;
  };
}

class DomainEventBus extends EventEmitter {
  emitEvent<T extends DomainEventType>(event: T, payload: DomainEventPayloadMap[T]): boolean {
    return this.emit(event, payload);
  }

  onEvent<T extends DomainEventType>(event: T, listener: (payload: DomainEventPayloadMap[T]) => void): this {
    return this.on(event, listener);
  }
}

export const domainEventBus = new DomainEventBus();
