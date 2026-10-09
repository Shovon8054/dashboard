// In‑memory MQTT connection status used by the API endpoint
export const mqttStatus = {
  connected: false as boolean,
  clientId: '' as string,
  lastChallengeId: '' as string,
  lastChallengeTime: '' as string,
  lastResponseStatus: '' as string,
  completed: 0 as number,
  failed: 0 as number,
  total: 0 as number,
};
