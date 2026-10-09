export const PROTOCOL_VERSION = '1.0';

export type ChallengeErrorCode =
  | 'VALIDATION_ERROR'
  | 'CANDIDATE_MISMATCH'
  | 'UNSUPPORTED_PROTOCOL'
  | 'CHALLENGE_EXPIRED'
  | 'CHALLENGE_CONFLICT'
  | 'INTERNAL_ERROR';

export interface MqttChallengePayload {
  protocol_version: string;
  candidate_id: string;
  challenge_id: string;
  command: string;
  events: any[];
  expires_at: string;
}

export type MqttValidationResult =
  | { ok: true; payload: MqttChallengePayload }
  | { ok: false; errorCode: ChallengeErrorCode; message: string; challengeId?: string };

/**
 * Validates the incoming MQTT challenge envelope.
 * Strictly uses only allowed error codes:
 * VALIDATION_ERROR, CANDIDATE_MISMATCH, UNSUPPORTED_PROTOCOL,
 * CHALLENGE_EXPIRED, CHALLENGE_CONFLICT, INTERNAL_ERROR.
 */
export function validateMqttChallenge(
  raw: string,
  expectedCandidateId: string
): MqttValidationResult {
  let parsed: any;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {
      ok: false,
      errorCode: 'VALIDATION_ERROR',
      message: 'Invalid JSON payload format',
    };
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return {
      ok: false,
      errorCode: 'VALIDATION_ERROR',
      message: 'Challenge payload must be a JSON object',
    };
  }

  const challengeId =
    typeof parsed.challenge_id === 'string' && parsed.challenge_id.trim()
      ? parsed.challenge_id.trim()
      : undefined;

  // 1. Protocol version validation
  if (parsed.protocol_version !== PROTOCOL_VERSION) {
    return {
      ok: false,
      errorCode: 'UNSUPPORTED_PROTOCOL',
      message: `Unsupported protocol_version "${parsed.protocol_version}". Expected "${PROTOCOL_VERSION}"`,
      challengeId,
    };
  }

  // 2. Candidate ID validation
  if (parsed.candidate_id !== expectedCandidateId) {
    return {
      ok: false,
      errorCode: 'CANDIDATE_MISMATCH',
      message: `candidate_id "${parsed.candidate_id}" does not match configured candidate ID`,
      challengeId,
    };
  }

  // 3. Challenge ID presence
  if (!challengeId) {
    return {
      ok: false,
      errorCode: 'VALIDATION_ERROR',
      message: 'challenge_id is required and non-empty',
      challengeId,
    };
  }

  // 4. Command validation
  if (parsed.command !== 'PROCESS_EVENTS') {
    return {
      ok: false,
      errorCode: 'VALIDATION_ERROR',
      message: `Invalid command "${parsed.command}". Expected "PROCESS_EVENTS"`,
      challengeId,
    };
  }

  // 5. Events array validation
  if (!Array.isArray(parsed.events)) {
    return {
      ok: false,
      errorCode: 'VALIDATION_ERROR',
      message: 'events must be an array',
      challengeId,
    };
  }

  // 6. Expiration check (expires_at)
  if (!parsed.expires_at || isNaN(Date.parse(parsed.expires_at))) {
    return {
      ok: false,
      errorCode: 'VALIDATION_ERROR',
      message: 'expires_at must be a valid ISO 8601 date string',
      challengeId,
    };
  }

  const expiresTime = new Date(parsed.expires_at).getTime();
  if (expiresTime <= Date.now()) {
    return {
      ok: false,
      errorCode: 'CHALLENGE_EXPIRED',
      message: `Challenge expired at ${parsed.expires_at}`,
      challengeId,
    };
  }

  return {
    ok: true,
    payload: {
      protocol_version: parsed.protocol_version,
      candidate_id: parsed.candidate_id,
      challenge_id: challengeId,
      command: parsed.command,
      events: parsed.events,
      expires_at: parsed.expires_at,
    },
  };
}
