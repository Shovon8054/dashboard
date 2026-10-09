export interface MqttRuntimeStatus {
  connected: boolean;
  candidate_id: string;
  client_id: string;
  last_challenge_id: string | null;
  last_challenge_time: string | null;
  last_response_status: string | null;
  last_error: string | null;
  completed_count: number;
  failed_count: number;
  total_count: number;
}

export const runtimeMqttStatus: MqttRuntimeStatus = {
  connected: false,
  candidate_id: process.env.CANDIDATE_ID || '',
  client_id: '',
  last_challenge_id: null,
  last_challenge_time: null,
  last_response_status: null,
  last_error: null,
  completed_count: 0,
  failed_count: 0,
  total_count: 0,
};
