import mqtt, { MqttClient } from 'mqtt';
import crypto from 'crypto';
import { runtimeMqttStatus } from './status';
import { PROTOCOL_VERSION } from './protocol';
import { handleMqttChallenge } from './service';

let mqttClient: MqttClient | null = null;
let heartbeatTimer: NodeJS.Timeout | null = null;
let reconnectTimer: NodeJS.Timeout | null = null;
let reconnectAttempt = 0;

export function publishMqttMessage(topic: string, message: string) {
  if (mqttClient && mqttClient.connected) {
    mqttClient.publish(topic, message, { qos: 1, retain: false }, (err) => {
      if (err) {
        console.error(`MQTT publish error to ${topic}:`, err.message);
      }
    });
  } else {
    console.warn(`MQTT not connected. Message dropped for ${topic}`);
  }
}

export function startMqttWorker() {
  const candidateId = process.env.CANDIDATE_ID;
  if (!candidateId || candidateId === '[my-assigned-candidate-id]') {
    console.warn('CANDIDATE_ID is not configured. MQTT worker skipped.');
    return;
  }

  const host = process.env.MQTT_HOST || '152.42.238.142';
  const port = process.env.MQTT_PORT || '1883';
  const brokerUrl = `mqtt://${host}:${port}`;

  const randomSuffix = crypto.randomBytes(3).toString('hex');
  const clientId = `fse01-${candidateId}-${randomSuffix}`;
  runtimeMqttStatus.candidate_id = candidateId;
  runtimeMqttStatus.client_id = clientId;

  const statusTopic = `fse01-${candidateId}/status`;
  const challengeTopic = `fse01-${candidateId}/challenge`;

  const willPayload = JSON.stringify({
    protocol_version: PROTOCOL_VERSION,
    candidate_id: candidateId,
    status: 'OFFLINE',
  });

  function connect() {
    if (mqttClient) {
      try {
        mqttClient.removeAllListeners();
        mqttClient.end(true);
      } catch {}
      mqttClient = null;
    }

    console.log(`Connecting to MQTT broker at ${brokerUrl} as ${clientId}...`);

    mqttClient = mqtt.connect(brokerUrl, {
      clientId,
      protocolVersion: 4, // MQTT 3.1.1
      clean: true,
      will: {
        topic: statusTopic,
        payload: Buffer.from(willPayload),
        qos: 1,
        retain: false,
      },
      reconnectPeriod: 0, // Manual exponential backoff
      connectTimeout: 10000,
    });

    mqttClient.on('connect', () => {
      console.log('Connected to MQTT broker.');
      runtimeMqttStatus.connected = true;
      runtimeMqttStatus.last_error = null;
      reconnectAttempt = 0;

      // Subscribe QoS 1
      mqttClient?.subscribe(challengeTopic, { qos: 1 }, (err) => {
        if (err) {
          console.error('MQTT subscribe error:', err.message);
          runtimeMqttStatus.last_error = err.message;
        } else {
          console.log(`Subscribed to ${challengeTopic}`);
          // Publish ONLINE status after subscribing
          publishMqttMessage(
            statusTopic,
            JSON.stringify({
              protocol_version: PROTOCOL_VERSION,
              candidate_id: candidateId,
              status: 'ONLINE',
            })
          );
        }
      });

      // Heartbeat every 30s
      if (heartbeatTimer) clearInterval(heartbeatTimer);
      heartbeatTimer = setInterval(() => {
        if (mqttClient?.connected) {
          publishMqttMessage(
            statusTopic,
            JSON.stringify({
              protocol_version: PROTOCOL_VERSION,
              candidate_id: candidateId,
              status: 'HEARTBEAT',
              timestamp: new Date().toISOString(),
            })
          );
        }
      }, 30000);
    });

    mqttClient.on('message', async (topic, message) => {
      if (topic === challengeTopic) {
        try {
          await handleMqttChallenge(message);
        } catch (err: any) {
          console.error('Unhandled challenge error:', err);
          runtimeMqttStatus.last_error = err?.message || 'Processing error';
        }
      }
    });

    mqttClient.on('error', (err) => {
      console.error('MQTT client error:', err.message);
      runtimeMqttStatus.last_error = err.message;
    });

    mqttClient.on('close', () => {
      runtimeMqttStatus.connected = false;
      if (heartbeatTimer) {
        clearInterval(heartbeatTimer);
        heartbeatTimer = null;
      }
      scheduleReconnect();
    });
  }

  function scheduleReconnect() {
    if (reconnectTimer) clearTimeout(reconnectTimer);
    reconnectAttempt++;
    const delay = Math.min(1000 * Math.pow(2, reconnectAttempt), 30000);
    console.log(`Reconnecting to MQTT in ${delay / 1000}s (attempt ${reconnectAttempt})...`);
    reconnectTimer = setTimeout(() => {
      connect();
    }, delay);
  }

  connect();
}
