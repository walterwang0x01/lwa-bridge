<script setup lang="ts">
import type { ConduitActiveRow, ConduitRecentRow } from '../types';
import { ago } from '../lib/format';
import Panel from './Panel.vue';
import EmptyState from './EmptyState.vue';

defineProps<{
  active: ConduitActiveRow[];
  recent: ConduitRecentRow[];
}>();
</script>

<template>
  <Panel
    title="Conduit"
    subtitle="ORCHESTRATION"
    :count="active.length + recent.length"
  >
    <EmptyState v-if="active.length === 0 && recent.length === 0" />
    <div v-else class="divide-y divide-white/5">
      <div v-if="active.length" class="px-4 py-2">
        <div class="mb-1 text-[10px] uppercase tracking-wide text-amber-400/80">Active</div>
        <div
          v-for="r in active"
          :key="r.conversationId"
          class="mb-2 rounded border border-amber-500/20 bg-amber-500/5 px-2 py-1.5 text-xs"
        >
          <div class="text-amber-200/90">{{ r.oneLiner }}</div>
          <div class="mt-0.5 flex flex-wrap gap-x-3 text-neutral-500">
            <code>{{ r.cwdShort }}</code>
            <span>{{ ago(r.startedAt) }}</span>
            <span>{{ r.eventCount }} events</span>
          </div>
        </div>
      </div>
      <div v-if="recent.length" class="px-4 py-2">
        <div class="mb-1 text-[10px] uppercase tracking-wide text-neutral-500">Recent run-state</div>
        <div
          v-for="r in recent"
          :key="r.cwd"
          class="flex flex-wrap items-center gap-x-3 gap-y-1 py-1.5 text-xs"
        >
          <code class="text-neutral-400">{{ r.cwdShort }}</code>
          <span class="text-emerald-400/80">✅{{ r.passed }}</span>
          <span class="text-rose-400/80">❌{{ r.failed }}</span>
          <span class="text-neutral-500">⏳{{ r.pending }}</span>
          <span v-if="r.baseBranch" class="text-neutral-500">base {{ r.baseBranch }}</span>
        </div>
      </div>
    </div>
  </Panel>
</template>
