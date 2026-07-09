import { WebClient } from '@slack/web-api';

/** Slack Ingress 运行时状态（port 与 channel 共享）。 */
export interface SlackIngressState {
  client: WebClient;
  botUserId: string;
  connected: boolean;
  /** message ts → Slack channel id（patchCard / getMessageContent 需要） */
  messageChannels: Map<string, string>;
}

export function createSlackIngressState(botToken: string): SlackIngressState {
  return {
    client: new WebClient(botToken),
    botUserId: '',
    connected: false,
    messageChannels: new Map(),
  };
}

export function rememberSlackMessage(state: SlackIngressState, channel: string, ts: string): void {
  if (ts) state.messageChannels.set(ts, channel);
}
