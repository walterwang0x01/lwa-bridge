<script setup lang="ts">
import type { SessionSummary } from '../types';
import { ago } from '../lib/format';
import Panel from './Panel.vue';
import EmptyState from './EmptyState.vue';

defineProps<{ sessions: SessionSummary[] }>();

const emit = defineEmits<{
  setRuntime: [payload: { conversationId: string; profileName: string }];
}>();

function channelLabel(ch?: string): string {
  if (ch === 'cli') return 'CLI';
  if (ch === 'slack') return 'Slack';
  return '飞书';
}

function runtimeLabel(s: SessionSummary): string {
  if (s.runtimeProfile && s.runtimeProfile !== 'auto') return s.runtimeProfile;
  if (s.lastUsedRuntimeProfile) return `Auto→${s.lastUsedRuntimeProfile}`;
  return 'Auto';
}
</script>

<template>
  <Panel title="会话" subtitle="SESSIONS" :count="sessions.length">
    <EmptyState v-if="sessions.length === 0" />
    <div v-else class="divide-y divide-white/5">
      <div
        v-for="s in sessions"
        :key="s.chatId"
        class="flex flex-col gap-1 px-4 py-2.5 text-sm"
      >
        <div class="flex flex-wrap items-center gap-x-3 gap-y-1">
          <span
            class="rounded bg-white/5 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-neutral-400"
          >
            {{ channelLabel(s.channel) }}
          </span>
          <code class="text-xs text-sky-400/90">{{ s.chatId }}</code>
          <span class="text-xs text-emerald-400/80">{{ runtimeLabel(s) }}</span>
          <span v-if="s.filesTouched" class="text-xs text-neutral-500">
            {{ s.filesTouched }} files
          </span>
          <span v-if="s.liveContextPct != null" class="text-xs text-neutral-500">
            ctx {{ s.liveContextPct }}%
          </span>
          <span class="ml-auto text-xs text-neutral-500">{{ ago(s.lastActiveAt) }}</span>
        </div>
        <div class="flex flex-wrap items-center gap-x-3 gap-y-1">
          <code class="min-w-0 flex-1 truncate text-xs text-neutral-400">{{
            s.cwdShort ?? s.currentCwd
          }}</code>
          <button
            class="rounded border border-white/10 px-1.5 py-0.5 text-[10px] text-neutral-400 hover:border-sky-500/40 hover:text-sky-300"
            type="button"
            @click="emit('setRuntime', { conversationId: s.chatId, profileName: 'auto' })"
          >
            Auto
          </button>
          <button
            class="rounded border border-white/10 px-1.5 py-0.5 text-[10px] text-neutral-400 hover:border-sky-500/40 hover:text-sky-300"
            type="button"
            @click="emit('setRuntime', { conversationId: s.chatId, profileName: 'kiro' })"
          >
            kiro
          </button>
          <button
            class="rounded border border-white/10 px-1.5 py-0.5 text-[10px] text-neutral-400 hover:border-sky-500/40 hover:text-sky-300"
            type="button"
            @click="emit('setRuntime', { conversationId: s.chatId, profileName: 'cursor' })"
          >
            cursor
          </button>
        </div>
      </div>
    </div>
  </Panel>
</template>
