import mqtt, { MqttClient } from 'mqtt';
import { env } from 'process';
import crypto from 'crypto';
import { validateMqttChallenge, PROTOCOL_VERSION, MqttChallenge } from './protocol';
import { upsertChallenge, storeChallengeResponse, getChallengeById, getMqttStats } from './repository';
import { processBatch } from '../events/service';
import { getSummary } from '../state/queries';
import { domainEventBus } from '../../shared/domain_events';
import { mqttStatus } from './status';
import { withTransaction } from '../../shared/db';

/**
 * Handles a single MQTT challenge message.
 * Publishes response and status topics.
 */
export async function handleMqttChallenge(message: Buffer) {
  const rawMsg = message.toString();
  const clientId = mqttStatus.clientId;
  const topicBase = `fse01-${env.CANDIDATE_ID}`;
  const responseTopic = `${topicBase}/response`;
  const statusTopic = `${topicBase}/status`;

  // Step 1 – basic validation (protocol version, candidate id, JSON)
  const validation = validateMqttChallenge(rawMsg, env.CANDIDATE_ID!);
  if (!validation.ok) {
    const failPayload = {
      protocol_version: PROTOCOL_VERSION,
      candidate_id: env.CANDIDATE_ID,
      challenge_id: undefined,
      status: 'FAILED',
      error_code: validation.errorCode,
      message: validation.message,
    };
    // publish failure status immediately
    mqttClient?.publish(statusTopic, JSON.stringify(failPayload), { qos: 1, retain: false });
    return;
  }

  const payload = validation.payload as MqttChallenge;
  const challengeId = payload.challenge_id;

  // Compute digest of request body for idempotency
  const requestDigest = crypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex');

  // Persist / retrieve challenge (idempotency)
  const client = await (await import('pg')).Pool.prototype.connect.call(null);
  const stored = await upsertChallenge(
    client,
    challengeId,
    requestDigest,
    payload,
    'RECEIVED'
  );
  client.release();

  // If we already have a response_body and the digests match, just republish it
  if (stored.response_body && stored.request_digest === requestDigest) {
    const existingResp = stored.response_body;
    mqttClient?.publish(responseTopic, JSON.stringify(existingResp), { qos: 1, retain: false });
    mqttClient?.publish(statusTopic, JSON.stringify({ ...existingResp, status: 'COMPLETED' }), { qos: 1, retain: false });
    return;
  }

  // Conflict detection – same challenge_id but different body
  if (stored.response_body && stored.request_digest !== requestDigest) {
    const failPayload = {
      protocol_version: PROTOCOL_VERSION,
      candidate_id: env.CANDIDATE_ID,
      challenge_id: challengeId,
      status: 'FAILED',
      error_code: 'CHALLENGE_CONFLICT',
      message: 'Same challenge_id with different payload'
    };
    await storeChallengeResponse(client, failPayload, 'FAILED');
    mqttClient?.publish(responseTopic, JSON.stringify(failPayload), { qos: 1, retain: false });
    mqttClient?.publish(statusTopic, JSON.stringify(failPayload), { qos: 1, retain: false });
    return;
  }

  // Valid challenge – process events via the same batch logic used by REST
  let batchResults;
  try {
    batchResults = await processBatch(payload.events);
  } catch (e) {
    const failPayload = {
      protocol_version: PROTOCOL_VERSION,
      candidate_id: env.CANDIDATE_ID,
      challenge_id: challengeId,
      status: 'FAILED',
      error_code: 'INTERNAL_ERROR',
      message: (e as Error).message ?? 'Unexpected error'
    };
    await storeChallengeResponse(client, failPayload, 'FAILED');
    mqttClient?.publish(responseTopic, JSON.stringify(failPayload), { qos: 1, retain: false });
    mqttClient?.publish(statusTopic, JSON.stringify(failPayload), { qos: 1, retain: false });
    return;
  }

  // Build state summary after processing
  const summary = await getSummary();

  const successPayload = {
    protocol_version: PROTOCOL_VERSION,
    candidate_id: env.CANDIDATE_ID,
    challenge_id: challengeId,
    status: 'COMPLETED',
    processed_at: new Date().toISOString(),
    results: batchResults.map(r => ({ event_id: r.event_id, status: r.status })),
    state: summary
  };

  // Persist response for idempotency
  await storeChallengeResponse(client, successPayload, 'COMPLETED');

  // Publish both response and status topics
  mqttClient?.publish(responseTopic, JSON.stringify(successPayload), { qos: 1, retain: false });
  mqttClient?.publish(statusTopic, JSON.stringify({ ...successPayload, status: 'COMPLETED' }), { qos: 1, retain: false });
}

// Global client reference for publishing inside handler
let mqttClient: MqttClient | null = null;

/**
 * Starts the MQTT client, sets up subscriptions, heartbeat, reconnect logic.
 */
export function startMqttWorker() {
  const candidateId = env.CANDIDATE_ID;
  if (!candidateId) {
    console.error('CANDIDATE_ID not set – MQTT worker will not start');
    return;
  }
  const randomSuffix = crypto.randomBytes(3).toString('hex');
  const clientId = `fse01-${candidateId}-${randomSuffix}`;
  mqttStatus.clientId = clientId;

  const host = env.MQTT_HOST || '152.42.238.142';
  const port = env.MQTT_PORT || '1883';
  const url = `mqtt://${host}:${port}`;

  const will = {
    topic: `fse01-${candidateId}/status`,
    payload: JSON.stringify({ protocol_version: PROTOCOL_VERSION, candidate_id: candidateId, status: 'OFFLINE' }),
    qos: 1,
    retain: false,
  };

  const options = { clientId, protocolVersion: 4, will, reconnectPeriod: 0 }; // manual backoff

  const connect = () => {
    console.log('Connecting to MQTT broker…');
    mqttClient = mqtt.connect(url, options);

    mqttClient.on('connect', () => {
      console.log('✅ MQTT connected');
      mqttStatus.connected = true;

      // Publish ONLINE status immediately
      const onlinePayload = { protocol_version: PROTOCOL_VERSION, candidate_id: candidateId, status: 'ONLINE' };
      mqttClient!.publish(`${clientId}/status`, JSON.stringify(onlinePayload), { qos: 1, retain: false });

      // Subscribe to challenge topic
      const challengeTopic = `fse01-${candidateId}/challenge`;
      mqttClient!.subscribe(challengeTopic, { qos: 1 }, (err) => {
        if (err) console.error('Subscribe error:', err);
        else console.log('Subscribed to', challengeTopic);
      });

      // Heartbeat interval
      const heartbeat = setInterval(() => {
        const hbPayload = { protocol_version: PROTOCOL_VERSION, candidate_id: candidateId, status: 'HEARTBEAT', timestamp: new Date().toISOString() };
        mqttClient!.publish(`${clientId}/status`, JSON.stringify(hbPayload), { qos: 1, retain: false });
      }, 30_000);

      // Clean up on disconnect
      mqttClient!.once('close', () => {
        clearInterval(heartbeat);
      });
    });

    mqttClient.on('message', async (topic, message) => {
      if (topic.endsWith('/challenge')) {
        try {
          await handleMqttChallenge(message);
        } catch (e) {
          console.error('Error handling MQTT challenge:', e);
        }
      }
    });

    mqttClient.on('error', (err) => {
      console.error('MQTT error:', err.message);
    });

    mqttClient.on('close', () => {
      console.warn('MQTT connection closed – will retry');
      mqttStatus.connected = false;
      setTimeout(connect, backoff()); // simple exponential backoff placeholder
    });
  };

  // Simple backoff function (capped at 30 seconds)
  let attempt = 0;
  const backoff = () => {
    attempt++;
    const delay = Math.min(1000 * 2 ** attempt, 30_000);
    console.log(`Reconnecting in ${delay / 1000}s (attempt ${attempt})`);
    return delay;
  };

  connect();
}

// Export client for unit‑tests if needed
export { mqttClient };
