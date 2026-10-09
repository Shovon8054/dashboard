import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { pool } from '../src/shared/db';
import { processEvent, processBatch } from '../src/modules/events/service';
import { getSummary } from '../src/modules/state/queries';
import { acknowledgeEvents } from '../src/modules/ack/service';
import { handleMqttChallenge } from '../src/modules/mqtt/service';
import { PROTOCOL_VERSION } from '../src/modules/mqtt/protocol';

describe('Production Event Processing System (Integration Tests)', () => {
  beforeEach(async () => {
    // Truncate tables between tests for clean isolation
    await pool.query(`
      TRUNCATE TABLE 
        production_events, 
        submission_attempts, 
        mqtt_challenges, 
        production_sources 
      CASCADE;
    `);
  });

  afterAll(async () => {
    await pool.end();
  });

  // Test 1: COUNT +5 -> net_total 5
  it('1. COUNT +5 increments net_total to 5 and sets status ACCEPTED', async () => {
    const payload = {
      source_id: 'sewing-line-A',
      event_id: 'evt-count-01',
      type: 'COUNT',
      quantity: 5,
      event_time: '2026-10-09T10:00:00.000Z',
    };

    const result = await processEvent(payload);
    expect(result.status).toBe('ACCEPTED');
    expect(result.event_id).toBe('evt-count-01');

    // Verify DB state
    const { rows } = await pool.query(
      'SELECT * FROM production_events WHERE event_id = $1',
      ['evt-count-01']
    );
    expect(rows.length).toBe(1);
    expect(rows[0].status).toBe('ACCEPTED');
    expect(Number(rows[0].quantity)).toBe(5);

    // Verify Summary
    const summary = await getSummary();
    expect(summary.net_total).toBe(5);
    expect(summary.processed_events).toBe(1);
    expect(summary.pending_ack).toBe(1);
  });

  // Test 2: Identical duplicate -> DUPLICATE, total stays 5, attempt recorded
  it('2. Identical duplicate returns DUPLICATE, keeps total at 5, and records attempt', async () => {
    const payload = {
      source_id: 'sewing-line-A',
      event_id: 'evt-dup-01',
      type: 'COUNT',
      quantity: 5,
      event_time: '2026-10-09T10:00:00.000Z',
    };

    // First submission
    const res1 = await processEvent(payload);
    expect(res1.status).toBe('ACCEPTED');

    // Duplicate submission
    const res2 = await processEvent(payload);
    expect(res2.status).toBe('DUPLICATE');

    // Total remains 5
    const summary = await getSummary();
    expect(summary.net_total).toBe(5);
    expect(summary.duplicates).toBe(1);

    // Verify submission_attempts log
    const { rows: attempts } = await pool.query(
      'SELECT * FROM submission_attempts WHERE event_id = $1 ORDER BY id ASC',
      ['evt-dup-01']
    );
    expect(attempts.length).toBe(2);
    expect(attempts[0].classification).toBe('ACCEPTED');
    expect(attempts[1].classification).toBe('DUPLICATE');
  });

  // Test 3: VOID before COUNT -> PENDING_REFERENCE, then COUNT arrives -> auto-resolved, net_total 0
  it('3. Out-of-order VOID becomes PENDING_REFERENCE, then auto-resolves when COUNT arrives', async () => {
    const targetId = 'target-count-100';
    const voidId = 'void-early-01';

    const voidPayload = {
      source_id: 'cutting-section-1',
      event_id: voidId,
      type: 'VOID',
      target_event_id: targetId,
      event_time: '2026-10-09T10:01:00.000Z',
    };

    // 1. VOID arrives before COUNT
    const voidRes = await processEvent(voidPayload);
    expect(voidRes.status).toBe('PENDING_REFERENCE');

    const summaryAfterVoid = await getSummary();
    expect(summaryAfterVoid.unresolved).toBe(1);
    expect(summaryAfterVoid.net_total).toBe(0);

    // 2. COUNT arrives later
    const countPayload = {
      source_id: 'cutting-section-1',
      event_id: targetId,
      type: 'COUNT',
      quantity: 12,
      event_time: '2026-10-09T10:00:00.000Z',
    };

    const countRes = await processEvent(countPayload);
    expect(countRes.status).toBe('ACCEPTED');

    // Verify DB resolution
    const { rows: countRows } = await pool.query(
      'SELECT * FROM production_events WHERE event_id = $1',
      [targetId]
    );
    expect(countRows[0].void_event_id).toBe(voidId);

    const { rows: voidRows } = await pool.query(
      'SELECT * FROM production_events WHERE event_id = $1',
      [voidId]
    );
    expect(voidRows[0].status).toBe('ACCEPTED');
    expect(voidRows[0].acknowledged_at).not.toBeNull(); // Auto-acknowledged

    // Net total is 0 because the VOID reversed the 12
    const finalSummary = await getSummary();
    expect(finalSummary.net_total).toBe(0);
    expect(finalSummary.unresolved).toBe(0);
  });

  // Test 4: Repeated acknowledgement -> ACKED then ALREADY_ACKED
  it('4. Repeated acknowledgement transitions from ACKED to ALREADY_ACKED safely', async () => {
    const eventId = 'evt-ack-test';
    await processEvent({
      source_id: 'finishing-line',
      event_id: eventId,
      type: 'COUNT',
      quantity: 20,
      event_time: '2026-10-09T10:00:00.000Z',
    });

    // Initial pending ack count
    const initialSummary = await getSummary();
    expect(initialSummary.pending_ack).toBe(1);

    // First ack
    const ack1 = await acknowledgeEvents([eventId]);
    expect(ack1[0].status).toBe('ACKED');

    const afterAck1Summary = await getSummary();
    expect(afterAck1Summary.pending_ack).toBe(0);

    // Verify DB acknowledged_at
    const { rows } = await pool.query(
      'SELECT acknowledged_at FROM production_events WHERE event_id = $1',
      [eventId]
    );
    expect(rows[0].acknowledged_at).not.toBeNull();

    // Second ack (repeat)
    const ack2 = await acknowledgeEvents([eventId]);
    expect(ack2[0].status).toBe('ALREADY_ACKED');
  });

  // Test 5: Repeated MQTT challenge (same ID + body) -> same response, events not reprocessed
  it('5. Repeated MQTT challenge returns same response and does not reprocess events', async () => {
    process.env.CANDIDATE_ID = 'test-candidate-123';
    const challengeId = 'chal-mqtt-999';

    const challenge = {
      protocol_version: PROTOCOL_VERSION,
      candidate_id: 'test-candidate-123',
      challenge_id: challengeId,
      command: 'PROCESS_EVENTS',
      events: [
        {
          source_id: 'mqtt-station-1',
          event_id: 'mqtt-evt-01',
          type: 'COUNT',
          quantity: 15,
          event_time: '2026-10-09T10:05:00.000Z',
        },
      ],
      expires_at: new Date(Date.now() + 60000).toISOString(),
    };

    const rawBuffer = Buffer.from(JSON.stringify(challenge));

    // First processing
    await handleMqttChallenge(rawBuffer);

    const { rows: challengeRows1 } = await pool.query(
      'SELECT * FROM mqtt_challenges WHERE challenge_id = $1',
      [challengeId]
    );
    expect(challengeRows1.length).toBe(1);
    expect(challengeRows1[0].status).toBe('COMPLETED');

    const { rowCount: eventCount1 } = await pool.query(
      'SELECT * FROM production_events WHERE event_id = $1',
      ['mqtt-evt-01']
    );
    expect(eventCount1).toBe(1);

    // Second execution with identical payload
    await handleMqttChallenge(rawBuffer);

    // Events in DB are unchanged (no re-insertion or attempts duplication)
    const { rowCount: eventCount2 } = await pool.query(
      'SELECT * FROM production_events'
    );
    expect(eventCount2).toBe(1);

    const summary = await getSummary();
    expect(summary.net_total).toBe(15);
  });

  // Bonus 6: Same event_id + different data -> CONFLICT
  it('Bonus 6: Same event_id with different payload returns CONFLICT and preserves original data', async () => {
    const eventId = 'evt-conflict-test';

    // Original event
    await processEvent({
      source_id: 'line-alpha',
      event_id: eventId,
      type: 'COUNT',
      quantity: 10,
      event_time: '2026-10-09T10:00:00.000Z',
    });

    // Conflicting event with different quantity
    const conflictRes = await processEvent({
      source_id: 'line-alpha',
      event_id: eventId,
      type: 'COUNT',
      quantity: 99,
      event_time: '2026-10-09T10:00:00.000Z',
    });

    expect(conflictRes.status).toBe('CONFLICT');

    // Original data preserved in DB
    const { rows } = await pool.query(
      'SELECT quantity FROM production_events WHERE event_id = $1',
      [eventId]
    );
    expect(Number(rows[0].quantity)).toBe(10);

    const summary = await getSummary();
    expect(summary.conflicts).toBe(1);
    expect(summary.net_total).toBe(10);
  });

  // Bonus 7: 10 concurrent identical submissions -> counted once
  it('Bonus 7: 10 concurrent identical submissions are safely counted once under DB locking', async () => {
    const payload = {
      source_id: 'concurrent-line',
      event_id: 'evt-race-01',
      type: 'COUNT',
      quantity: 50,
      event_time: '2026-10-09T10:00:00.000Z',
    };

    const promises = Array.from({ length: 10 }).map(() => processEvent(payload));
    const results = await Promise.all(promises);

    const acceptedCount = results.filter((r) => r.status === 'ACCEPTED').length;
    const duplicateCount = results.filter((r) => r.status === 'DUPLICATE').length;

    expect(acceptedCount).toBe(1);
    expect(duplicateCount).toBe(9);

    const summary = await getSummary();
    expect(summary.net_total).toBe(50);
  });

  // Bonus 8: Mixed batch with one invalid item -> invalid item REJECTED, valid items succeed
  it('Bonus 8: Mixed batch preserves submission order, rejects invalid item, succeeds for valid items', async () => {
    const batch = [
      {
        source_id: 'batch-line',
        event_id: 'batch-01',
        type: 'COUNT',
        quantity: 10,
        event_time: '2026-10-09T10:00:00.000Z',
      },
      {
        source_id: 'batch-line',
        event_id: 'batch-invalid',
        type: 'COUNT',
        quantity: -5, // Invalid negative quantity
        event_time: '2026-10-09T10:00:00.000Z',
      },
      {
        source_id: 'batch-line',
        event_id: 'batch-02',
        type: 'COUNT',
        quantity: 20,
        event_time: '2026-10-09T10:00:00.000Z',
      },
    ];

    const results = await processBatch(batch);

    expect(results.length).toBe(3);
    expect(results[0].status).toBe('ACCEPTED');
    expect(results[1].status).toBe('REJECTED');
    expect(results[2].status).toBe('ACCEPTED');

    const summary = await getSummary();
    expect(summary.net_total).toBe(30);

    // Verify invalid attempt was persisted
    const { rows: rejections } = await pool.query(
      'SELECT * FROM submission_attempts WHERE classification = $1',
      ['REJECTED']
    );
    expect(rejections.length).toBe(1);
    expect(rejections[0].event_id).toBe('batch-invalid');
  });

  // Change Request Tests:
  // 1. COUNT 450 -> ACCEPTED, total increases by 450.
  it('CR 1: COUNT 450 -> ACCEPTED, total increases by 450', async () => {
    const payload = {
      source_id: 'line-valid-450',
      event_id: 'evt-count-450',
      type: 'COUNT',
      quantity: 450,
      event_time: '2026-10-09T10:00:00.000Z',
    };

    const result = await processEvent(payload);
    expect(result.status).toBe('ACCEPTED');

    const summary = await getSummary();
    expect(summary.net_total).toBe(450);
  });

  // 2. COUNT 500 -> ACCEPTED (boundary).
  it('CR 2: COUNT 500 -> ACCEPTED (boundary)', async () => {
    const payload = {
      source_id: 'line-boundary-500',
      event_id: 'evt-count-500',
      type: 'COUNT',
      quantity: 500,
      event_time: '2026-10-09T10:00:00.000Z',
    };

    const result = await processEvent(payload);
    expect(result.status).toBe('ACCEPTED');

    const summary = await getSummary();
    expect(summary.net_total).toBe(500);

    const { rows } = await pool.query(
      'SELECT * FROM production_events WHERE event_id = $1',
      ['evt-count-500']
    );
    expect(rows.length).toBe(1);
    expect(Number(rows[0].quantity)).toBe(500);
  });

  // 3. COUNT 501 -> REJECTED, total unchanged, attempt stored in PostgreSQL.
  it('CR 3: COUNT 501 -> REJECTED, total unchanged, attempt stored in PostgreSQL', async () => {
    const payload = {
      source_id: 'line-overlimit-501',
      event_id: 'evt-count-501',
      type: 'COUNT',
      quantity: 501,
      event_time: '2026-10-09T10:00:00.000Z',
    };

    const result = await processEvent(payload);
    expect(result.status).toBe('REJECTED');
    expect(result.reason).toContain('quantity must be between 1 and 500');

    // Total unchanged
    const summary = await getSummary();
    expect(summary.net_total).toBe(0);

    // No row in production_events
    const { rows: events } = await pool.query(
      'SELECT * FROM production_events WHERE event_id = $1',
      ['evt-count-501']
    );
    expect(events.length).toBe(0);

    // Attempt stored in submission_attempts
    const { rows: attempts } = await pool.query(
      'SELECT * FROM submission_attempts WHERE event_id = $1',
      ['evt-count-501']
    );
    expect(attempts.length).toBe(1);
    expect(attempts[0].classification).toBe('REJECTED');
    expect(attempts[0].error).toContain('quantity must be between 1 and 500');
  });

  // 4. Same 501 COUNT through the MQTT challenge handler -> REJECTED item inside a COMPLETED response.
  it('CR 4: Same 501 COUNT through MQTT challenge handler -> REJECTED item inside a COMPLETED response', async () => {
    process.env.CANDIDATE_ID = 'test-candidate-123';
    const challengeId = 'chal-mqtt-501';

    const challenge = {
      protocol_version: PROTOCOL_VERSION,
      candidate_id: 'test-candidate-123',
      challenge_id: challengeId,
      command: 'PROCESS_EVENTS',
      events: [
        {
          source_id: 'mqtt-station-overlimit',
          event_id: 'mqtt-evt-501',
          type: 'COUNT',
          quantity: 501,
          event_time: '2026-10-09T10:05:00.000Z',
        },
      ],
      expires_at: new Date(Date.now() + 60000).toISOString(),
    };

    const rawBuffer = Buffer.from(JSON.stringify(challenge));
    await handleMqttChallenge(rawBuffer);

    const { rows } = await pool.query(
      'SELECT * FROM mqtt_challenges WHERE challenge_id = $1',
      [challengeId]
    );
    expect(rows.length).toBe(1);
    expect(rows[0].status).toBe('COMPLETED');

    const responseBody =
      typeof rows[0].response_body === 'string'
        ? JSON.parse(rows[0].response_body)
        : rows[0].response_body;

    expect(responseBody.status).toBe('COMPLETED');
    expect(responseBody.results).toHaveLength(1);
    expect(responseBody.results[0].event_id).toBe('mqtt-evt-501');
    expect(responseBody.results[0].status).toBe('REJECTED');
  });

  // 5. get_summary(): rejected_submissions counts only REJECTED (not duplicates, conflicts, pending), returns 0 when none, and respects source_id.
  it('CR 5: get_summary(): rejected_submissions counts only REJECTED, returns 0 when none, respects source_id', async () => {
    // 0 when none
    const emptySummary = await getSummary();
    expect(emptySummary.rejected_submissions).toBe(0);

    // Accepted COUNT on source-A
    await processEvent({
      source_id: 'source-A',
      event_id: 'evt-base-A',
      type: 'COUNT',
      quantity: 10,
      event_time: '2026-10-09T10:00:00.000Z',
    });

    // DUPLICATE attempt on source-A
    await processEvent({
      source_id: 'source-A',
      event_id: 'evt-base-A',
      type: 'COUNT',
      quantity: 10,
      event_time: '2026-10-09T10:00:00.000Z',
    });

    // CONFLICT attempt on source-A
    await processEvent({
      source_id: 'source-A',
      event_id: 'evt-base-A',
      type: 'COUNT',
      quantity: 20,
      event_time: '2026-10-09T10:00:00.000Z',
    });

    // Unresolved VOID (pending reference) on source-A
    await processEvent({
      source_id: 'source-A',
      event_id: 'evt-void-unresolved',
      type: 'VOID',
      target_event_id: 'non-existent-target',
      event_time: '2026-10-09T10:01:00.000Z',
    });

    // REJECTED attempt on source-A (quantity > 500)
    await processEvent({
      source_id: 'source-A',
      event_id: 'evt-rej-A',
      type: 'COUNT',
      quantity: 505,
      event_time: '2026-10-09T10:02:00.000Z',
    });

    // REJECTED attempt on source-B
    await processEvent({
      source_id: 'source-B',
      event_id: 'evt-rej-B',
      type: 'COUNT',
      quantity: 520,
      event_time: '2026-10-09T10:02:00.000Z',
    });

    // Global summary
    const globalSummary = await getSummary();
    expect(globalSummary.rejected_submissions).toBe(2);
    expect(globalSummary.duplicates).toBe(1);
    expect(globalSummary.conflicts).toBe(1);
    expect(globalSummary.unresolved).toBe(1);
    expect(globalSummary.net_total).toBe(10);

    // Filtered by source-A
    const summaryA = await getSummary('source-A');
    expect(summaryA.rejected_submissions).toBe(1);
    expect(summaryA.duplicates).toBe(1);
    expect(summaryA.conflicts).toBe(1);
    expect(summaryA.unresolved).toBe(1);
    expect(summaryA.net_total).toBe(10);

    // Filtered by source-B
    const summaryB = await getSummary('source-B');
    expect(summaryB.rejected_submissions).toBe(1);
    expect(summaryB.duplicates).toBe(0);
    expect(summaryB.conflicts).toBe(0);
    expect(summaryB.net_total).toBe(0);

    // Filtered by source-C (none)
    const summaryC = await getSummary('source-C');
    expect(summaryC.rejected_submissions).toBe(0);
  });

  // 6. MQTT response state includes rejected_submissions.
  it('CR 6: MQTT response state includes rejected_submissions', async () => {
    // Generate 1 rejected submission first
    await processEvent({
      source_id: 'mqtt-line-rej',
      event_id: 'rej-before-mqtt',
      type: 'COUNT',
      quantity: 505,
      event_time: '2026-10-09T10:00:00.000Z',
    });

    process.env.CANDIDATE_ID = 'test-candidate-123';
    const challengeId = 'chal-mqtt-state-check';

    const challenge = {
      protocol_version: PROTOCOL_VERSION,
      candidate_id: 'test-candidate-123',
      challenge_id: challengeId,
      command: 'PROCESS_EVENTS',
      events: [
        {
          source_id: 'mqtt-line-rej',
          event_id: 'mqtt-valid-evt',
          type: 'COUNT',
          quantity: 20,
          event_time: '2026-10-09T10:10:00.000Z',
        },
      ],
      expires_at: new Date(Date.now() + 60000).toISOString(),
    };

    await handleMqttChallenge(Buffer.from(JSON.stringify(challenge)));

    const { rows } = await pool.query(
      'SELECT response_body FROM mqtt_challenges WHERE challenge_id = $1',
      [challengeId]
    );
    expect(rows.length).toBe(1);

    const responseBody =
      typeof rows[0].response_body === 'string'
        ? JSON.parse(rows[0].response_body)
        : rows[0].response_body;

    expect(responseBody.state).toBeDefined();
    expect(responseBody.state).toHaveProperty('rejected_submissions');
    expect(responseBody.state.rejected_submissions).toBe(1);
    expect(responseBody.state.net_total).toBe(20);
  });
});
