<script setup lang="ts">
import type { CronSummary } from '../types';
import { ago } from '../lib/format';
import Panel from './Panel.vue';
import EmptyState from './EmptyState.vue';

defineProps<{ cron: CronSummary[] }>();
</script>

<template>
  <Panel title="定时任务" subtitle="CRON" :count="cron.length">
    <EmptyState v-if="cron.length === 0" />
    <div v-else class="divide-y divide-white/5">
      <div
        v-for="t in cron"
        :key="t.id"
        class="flex flex-wrap items-center gap-x-4 gap-y-1 px-4 py-2.5 text-sm"
      >
        <span
          class="h-2 w-2 rounded-full"
          :class="t.enabled ? 'bg-emerald-400' : 'bg-neutral-600'"
          :title="t.enabled ? '已启用' : '已暂停'"
        />
        <span class="min-w-0 flex-1 truncate text-neutral-300">{{ t.description || '—' }}</span>
        <code class="text-xs text-amber-400/80">{{ t.expression }}</code>
        <span class="text-xs text-neutral-500">上次 {{ ago(t.lastRunAt) }}</span>
        <code class="text-xs text-neutral-600">{{ t.id }}</code>
      </div>
    </div>
  </Panel>
</template>
