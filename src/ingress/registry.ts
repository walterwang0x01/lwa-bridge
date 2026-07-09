import type { ChannelId, IngressChannel } from './types.js';

const channels = new Map<ChannelId, IngressChannel>();

export function registerIngressChannel(channel: IngressChannel): void {
  channels.set(channel.id, channel);
}

export function getIngressChannel(id: ChannelId): IngressChannel | undefined {
  return channels.get(id);
}

export function listIngressChannels(): ChannelId[] {
  return [...channels.keys()];
}

export function clearIngressRegistry(): void {
  channels.clear();
}
