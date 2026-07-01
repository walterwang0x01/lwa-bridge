<script setup lang="ts">
import type { SessionSummary } from '../types';
import { ago } from '../lib/format';
import Panel from './Panel.vue';
import EmptyState from './EmptyState.vue';

defineProps<{ sessions: SessionSummary[] }>();
</script>

<template>
  <Panel title="会话" subtitle="SESSIONS" :count="sessions.length">
    <EmptyState v-if="sessions.length === 0" />
    <div v-else class="divide-y divide-white/5">
      <div
        v-for="s in sessions"
        :key="s.chatId"
        class="flex flex-wrap items-center gap-x-4 gap-y-1 px-4 py-2.5 text-sm"
      >
        <code class="text-xs text-sky-400/90">{{ s.chatId }}</code>
        <code class="min-w-0 flex-1 truncate text-xs text-neutral-400">{{ s.currentCwd }}</code>
        <span class="text-xs text-neutral-500">{{ s.cwdCount }} 会话</span>
        <span class="text-xs text-neutral-500">{{ ago(s.lastActiveAt) }}</span>
      </div>
    </div>
  </Panel>
</template>
