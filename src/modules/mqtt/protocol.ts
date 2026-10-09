// MQTT protocol utilities – validation and error handling
import { ProductionEventPayload } from '../../shared/contracts';
import { ZodError, z } from 'zod';

export const PROTOCOL_VERSION = '1.0';

// Schema for the incoming challenge payload
const challengeSchema = z.object({
  protocol_version: z.literal(PROTOCOL_VERSION),
  candidate_id: z.string().min(1),
  challenge_id: z.string().min(1),
  command: z.literal('PROCESS_EVENTS'),
  events: z.array(z.object({
    source_id: z.string().min(1),
    event_id: z.string().min(1),
    type: z.enum(['COUNT','VOID']),
    quantity: z.number().int().positive().optional(),
    target_event_id: z.string().optional(),
    event_time: z.string().refine(val => !isNaN(Date.parse(val)), { message: 'invalid ISO date' })
  })),
  expires_at: z.string().refine(val => !isNaN(Date.parse(val)), { message: 'invalid expires_at' })
});

export type MqttChallenge = z.infer<typeof challengeSchema>;

/**
 * Validate raw JSON string from MQTT.
 * Returns { ok:true, payload } or { ok:false, errorCode, message }.
 */
export function validateMqttChallenge(raw: string, myCandidateId: string) {
  let parsed: any;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    return { ok:false, errorCode:'VALIDATION_ERROR', message:'Invalid JSON' } as const;
  }

  // Quick protocol_version check (before full schema) for better error code
  if (parsed.protocol_version !== PROTOCOL_VERSION) {
    return { ok:false, errorCode:'UNSUPPORTED_PROTOCOL', message:'Unsupported protocol_version' } as const;
  }
  if (parsed.candidate_id !== myCandidateId) {
    return { ok:false, errorCode:'CANDIDATE_MISMATCH', message:'candidate_id does not match' } as const;
  }

  try {
    const payload = challengeSchema.parse(parsed);
    // expiration check
    if (new Date(payload.expires_at).getTime() < Date.now()) {
      return { ok:false, errorCode:'CHALLENGE_EXPIRED', message:'Challenge has expired' } as const;
    }
    return { ok:true, payload } as const;
  } catch (e) {
    if (e instanceof ZodError) {
      return { ok:false, errorCode:'VALIDATION_ERROR', message: e.errors.map(err=>err.message).join('; ') } as const;
    }
    return { ok:false, errorCode:'VALIDATION_ERROR', message:'Schema validation failed' } as const;
  }
}
