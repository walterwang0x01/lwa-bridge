import type { LarkClient } from '../../lark/client.js';
import type { IngressChannel, IngressInboundHandlers } from '../types.js';
import { fromLarkCardAction, fromLarkMessage } from './normalize.js';
import { createLarkIngressPort } from './port.js';

export function createLarkIngressChannel(client: LarkClient): IngressChannel {
  const port = createLarkIngressPort(client);
  return {
    id: 'lark',
    port,
    async startInbound(handlers: IngressInboundHandlers): Promise<void> {
      await client.startEventLoop({
        onMessage: (msg) => handlers.onMessage(fromLarkMessage(msg)),
        onCardAction: handlers.onCardAction
          ? (evt) => handlers.onCardAction!(fromLarkCardAction(evt))
          : undefined,
        onReady: handlers.onReady,
        onReconnected: handlers.onReconnected,
      });
    },
    close: () => client.close(),
  };
}
