import type { IngressChannel, IngressInboundHandlers } from '../types.js';
import { createSlackIngressPort } from './port.js';

export interface SlackIngressConfig {
  botToken?: string;
  appToken?: string;
  signingSecret?: string;
}

/**
 * Slack Ingress 骨架（2027 Q1 目标渠道）。
 * 注册后可被 registry 发现；startInbound 在实现完成前会抛明确错误。
 */
export function createSlackIngressChannel(config: SlackIngressConfig = {}): IngressChannel {
  const hasTokens = Boolean(config.botToken && config.appToken);
  const port = createSlackIngressPort();
  return {
    id: 'slack',
    port,
    async startInbound(_handlers: IngressInboundHandlers): Promise<void> {
      if (!hasTokens) {
        throw new Error(
          'Slack ingress requires ingress.slack.botToken and appToken (Socket Mode); skeleton only',
        );
      }
      throw new Error(
        'Slack Socket Mode adapter not implemented yet; use ingress.channel=lark for production',
      );
    },
    close: () => undefined,
  };
}
