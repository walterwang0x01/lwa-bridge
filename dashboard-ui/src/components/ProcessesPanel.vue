<script setup lang="ts">
import type { ProcessSummary } from '../types';
import { fmtTime } from '../lib/format';
import Panel from './Panel.vue';
import EmptyState from './EmptyState.vue';

defineProps<{ processes: ProcessSummary[] }>();
</script>

<template>
  <Panel title="进程" subtitle="PROCESSES" :count="processes.length">
    <EmptyState v-if="processes.length === 0" />
    <div v-else class="divide-y divide-white/5">
      <div
        v-for="p in processes"
        :key="p.pid"
        class="flex flex-wrap items-center gap-x-4 gap-y-1 px-4 py-2.5 text-sm"
      >
        <code class="text-xs text-neutral-300">PID {{ p.pid }}</code>
        <code class="text-xs text-violet-400/80">{{ p.shortId }}</code>
        <span class="text-xs text-neutral-500">{{ fmtTime(p.startedAt) }}</span>
        <code class="min-w-0 flex-1 truncate text-xs text-neutral-500">{{ p.cwd }}</code>
      </div>
    </div>
  </Panel>
</template>
