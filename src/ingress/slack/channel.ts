import { App, type App as SlackApp } from '@slack/bolt';
import type { Logger } from 'pino';
import type { IngressChannel, IngressInboundHandlers } from '../types.js';
import { fromSlackBlockAction, fromSlackMessage } from './normalize.js';
import { createSlackIngressPort, createSlackIngressPortStub } from './port.js';
import { createSlackIngressState } from './state.js';

export interface SlackIngressConfig {
  botToken?: string;
  appToken?: string;
  signingSecret?: string;
  logger?: Logger;
}

function isSlackMessageEvent(event: unknown): event is {
  type: string;
  subtype?: string;
  channel?: string;
  ts?: string;
  user?: string;
  text?: string;
  thread_ts?: string;
  bot_id?: string;
} {
  return Boolean(
    event &&
      typeof event === 'object' &&
      'type' in event &&
      (event as { type: string }).type === 'message',
  );
}

function wireSlackApp(app: SlackApp, handlers: IngressInboundHandlers): void {
  const dispatchMessage = async (
    event: {
      type: string;
      subtype?: string;
      channel?: string;
      ts?: string;
      user?: string;
      text?: string;
      thread_ts?: string;
      bot_id?: string;
    },
    eventId: string,
  ) => {
    const normalized = fromSlackMessage(event, eventId);
    if (!normalized) return;
    await handlers.onMessage(normalized);
  };

  app.event('message', async ({ event, body }) => {
    if (!isSlackMessageEvent(event)) return;
    await dispatchMessage(event, body.event_id ?? `msg-${event.ts}`);
  });

  app.event('app_mention', async ({ event, body }) => {
    if (!isSlackMessageEvent(event)) return;
    await dispatchMessage(event, body.event_id ?? `mention-${event.ts}`);
  });

  if (handlers.onCardAction) {
    app.action(/.+/, async ({ action, body, ack }) => {
      await ack();
      if (action.type !== 'button') return;
      const actionBody = body as {
        channel?: { id?: string };
        message?: { ts?: string };
        user?: { id?: string };
      };
      const evt = fromSlackBlockAction(actionBody, {
        type: action.type,
        value: 'value' in action ? String(action.value ?? '') : undefined,
      });
      if (evt) await handlers.onCardAction!(evt);
    });
  }
}

/**
 * Slack Ingress（Socket Mode）。
 * 配置 `ingress.slack.botToken` + `appToken` 后可用；`ingress.channel=slack` 切换主渠道。
 */
export function createSlackIngressChannel(config: SlackIngressConfig = {}): IngressChannel {
  const hasTokens = Boolean(config.botToken && config.appToken);
  if (!hasTokens) {
    return {
      id: 'slack',
      port: createSlackIngressPortStub(),
      async startInbound(): Promise<void> {
        throw new Error('Slack ingress requires ingress.slack.botToken and appToken (Socket Mode)');
      },
      close: () => undefined,
    };
  }

  const state = createSlackIngressState(config.botToken!);
  const port = createSlackIngressPort(state);
  let app: SlackApp | null = null;
  const log = config.logger?.child({ module: 'slack-ingress' });

  return {
    id: 'slack',
    port,
    async startInbound(handlers: IngressInboundHandlers): Promise<void> {
      app = new App({
        token: config.botToken,
        appToken: config.appToken,
        signingSecret: config.signingSecret,
        socketMode: true,
      });

      wireSlackApp(app, handlers);

      app.error(async (error) => {
        log?.error({ err: error }, 'slack bolt error');
      });

      await app.start();
      state.connected = true;

      try {
        const auth = await state.client.auth.test();
        state.botUserId = auth.user_id ?? '';
        port.setBotPrincipalId(state.botUserId);
        log?.info({ botUserId: state.botUserId }, 'slack socket mode connected');
      } catch (e) {
        log?.warn({ err: e }, 'slack auth.test failed (non-fatal)');
      }

      handlers.onReady?.();
    },
    close: () => {
      state.connected = false;
      if (app) {
        void app.stop();
        app = null;
      }
    },
  };
}
