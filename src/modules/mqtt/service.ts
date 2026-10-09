import crypto from 'crypto';
import {
  validateMqttChallenge,
  PROTOCOL_VERSION,
  MqttChallengePayload,
} from './protocol';
import {
  upsertChallenge,
  storeChallengeResponse,
  getMqttStats,
} from './repository';
import { processBatch } from '../events/service';
import { getSummary } from '../state/queries';
import { runtimeMqttStatus } from './status';
import { pool } from '../../shared/db';
import { publishMqttMessage } from './worker';

export async function handleMqttChallenge(message: Buffer) {
  const rawMsg = message.toString();
  const myCandidateId = process.env.CANDIDATE_ID || '';
  const topicBase = `fse01-${myCandidateId}`;
  const responseTopic = `${topicBase}/response`;
  const statusTopic = `${topicBase}/status`;

  // 1. Envelope validation
  const validation = validateMqttChallenge(rawMsg, myCandidateId);
  if (!validation.ok) {
    const failPayload = {
      protocol_version: PROTOCOL_VERSION,
      candidate_id: myCandidateId,
      challenge_id: validation.challengeId || 'unknown',
      status: 'FAILED',
      error_code: validation.errorCode,
      message: validation.message,
    };

    runtimeMqttStatus.last_error = `[${validation.errorCode}] ${validation.message}`;
    runtimeMqttStatus.last_response_status = 'FAILED';
    runtimeMqttStatus.failed_count++;
    runtimeMqttStatus.total_count++;

    const failStr = JSON.stringify(failPayload);
    publishMqttMessage(responseTopic, failStr);

    // If challengeId is available, record failure in DB
    if (validation.challengeId) {
      const client = await pool.connect();
      try {
        const dummyDigest = crypto
          .createHash('sha256')
          .update(rawMsg)
          .digest('hex');
        await upsertChallenge(
          client,
          validation.challengeId,
          dummyDigest,
          { raw: rawMsg },
          'FAILED',
          validation.errorCode
        );
        await storeChallengeResponse(
          client,
          validation.challengeId,
          failPayload,
          'FAILED',
          validation.errorCode
        );
      } catch {} finally {
        client.release();
      }
    }
    return;
  }

  const payload: MqttChallengePayload = validation.payload;
  const challengeId = payload.challenge_id;
  const nowIso = new Date().toISOString();

  runtimeMqttStatus.last_challenge_id = challengeId;
  runtimeMqttStatus.last_challenge_time = nowIso;

  // Normalized digest for idempotency
  const requestDigest = crypto
    .createHash('sha256')
    .update(JSON.stringify(payload))
    .digest('hex');

  const client = await pool.connect();
  try {
    const stored = await upsertChallenge(
      client,
      challengeId,
      requestDigest,
      payload,
      'PENDING'
    );

    // 2. Idempotency Check
    if (stored.response_body) {
      if (stored.request_digest === requestDigest) {
        // Same ID + same body -> republish stored original response, do NOT reprocess
        const resp =
          typeof stored.response_body === 'string'
            ? stored.response_body
            : JSON.stringify(stored.response_body);
        publishMqttMessage(responseTopic, resp);
        runtimeMqttStatus.last_response_status = stored.status;
        return;
      } else {
        // Same ID + changed body -> FAILED / CHALLENGE_CONFLICT
        const conflictPayload = {
          protocol_version: PROTOCOL_VERSION,
          candidate_id: myCandidateId,
          challenge_id: challengeId,
          status: 'FAILED',
          error_code: 'CHALLENGE_CONFLICT',
          message: 'Same challenge_id submitted with conflicting payload',
        };
        await storeChallengeResponse(
          client,
          challengeId,
          conflictPayload,
          'FAILED',
          'CHALLENGE_CONFLICT'
        );
        runtimeMqttStatus.last_error = conflictPayload.message;
        runtimeMqttStatus.last_response_status = 'FAILED';
        runtimeMqttStatus.failed_count++;
        runtimeMqttStatus.total_count++;

        publishMqttMessage(responseTopic, JSON.stringify(conflictPayload));
        return;
      }
    }

    // 3. Process events via the exact same processBatch() as REST
    let batchResults;
    try {
      batchResults = await processBatch(payload.events);
    } catch (err: any) {
      const internalErrorPayload = {
        protocol_version: PROTOCOL_VERSION,
        candidate_id: myCandidateId,
        challenge_id: challengeId,
        status: 'FAILED',
        error_code: 'INTERNAL_ERROR',
        message: err?.message || 'Internal processing error',
      };
      await storeChallengeResponse(
        client,
        challengeId,
        internalErrorPayload,
        'FAILED',
        'INTERNAL_ERROR'
      );
      runtimeMqttStatus.last_error = internalErrorPayload.message;
      runtimeMqttStatus.last_response_status = 'FAILED';
      runtimeMqttStatus.failed_count++;
      runtimeMqttStatus.total_count++;

      publishMqttMessage(responseTopic, JSON.stringify(internalErrorPayload));
      return;
    }

    // 4. Build State Summary
    const stateSummary = await getSummary();

    const successPayload = {
      protocol_version: PROTOCOL_VERSION,
      candidate_id: myCandidateId,
      challenge_id: challengeId,
      status: 'COMPLETED',
      processed_at: new Date().toISOString(),
      results: batchResults.map((r) => ({
        event_id: r.event_id,
        status: r.status,
      })),
      state: stateSummary,
    };

    await storeChallengeResponse(client, challengeId, successPayload, 'COMPLETED');

    runtimeMqttStatus.last_response_status = 'COMPLETED';
    runtimeMqttStatus.completed_count++;
    runtimeMqttStatus.total_count++;

    // Publish to response topic (QoS 1, retain false)
    publishMqttMessage(responseTopic, JSON.stringify(successPayload));
  } finally {
    client.release();
  }
}

export async function getMqttStatus() {
  try {
    const stats = await getMqttStats();
    return {
      connected: runtimeMqttStatus.connected,
      candidate_id: process.env.CANDIDATE_ID || '',
      client_id: runtimeMqttStatus.client_id,
      last_challenge_id: runtimeMqttStatus.last_challenge_id,
      last_challenge_time: runtimeMqttStatus.last_challenge_time,
      last_response_status: runtimeMqttStatus.last_response_status,
      last_error: runtimeMqttStatus.last_error,
      challenge_counts: {
        completed: Math.max(runtimeMqttStatus.completed_count, stats.completed),
        failed: Math.max(runtimeMqttStatus.failed_count, stats.failed),
        total: Math.max(runtimeMqttStatus.total_count, stats.total),
      },
    };
  } catch {
    return {
      connected: runtimeMqttStatus.connected,
      candidate_id: process.env.CANDIDATE_ID || '',
      client_id: runtimeMqttStatus.client_id,
      last_challenge_id: runtimeMqttStatus.last_challenge_id,
      last_challenge_time: runtimeMqttStatus.last_challenge_time,
      last_response_status: runtimeMqttStatus.last_response_status,
      last_error: runtimeMqttStatus.last_error,
      challenge_counts: {
        completed: runtimeMqttStatus.completed_count,
        failed: runtimeMqttStatus.failed_count,
        total: runtimeMqttStatus.total_count,
      },
    };
  }
}
