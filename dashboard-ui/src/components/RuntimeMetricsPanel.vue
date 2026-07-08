<script setup lang="ts">
import type { AdaptiveRecommendation, RuntimeMetricsRow } from '../types';
import Panel from './Panel.vue';
import EmptyState from './EmptyState.vue';

defineProps<{ rows: RuntimeMetricsRow[]; recommendation?: AdaptiveRecommendation | null }>();

function percent(v: number): string {
  return `${Math.round(v * 100)}%`;
}

function duration(ms: number): string {
  return `${Math.round(ms / 1000)}s`;
}
</script>

<template>
  <Panel title="Runtime 指标" subtitle="METRICS" :count="rows.length">
    <div
      v-if="recommendation && recommendation.sampleSize > 0"
      class="border-b border-white/5 bg-white/[0.02] px-4 py-2 text-xs text-neutral-400"
    >
      推荐：
      runtime=<span class="text-neutral-200">{{ recommendation.preferredRuntimeKind || '保持当前' }}</span>
      · model=<span class="text-teal-300">{{ recommendation.preferredModel || '保持当前' }}</span>
      · samples={{ recommendation.sampleSize }}
    </div>
    <EmptyState v-if="rows.length === 0" text="还没有 runtime 指标" />
    <div v-else class="overflow-x-auto">
      <table class="min-w-full text-left text-xs text-neutral-400">
        <thead class="bg-white/[0.02] text-neutral-500">
          <tr>
            <th class="px-4 py-2 font-medium">Runtime</th>
            <th class="px-4 py-2 font-medium">Model</th>
            <th class="px-4 py-2 font-medium">Total</th>
            <th class="px-4 py-2 font-medium">Success</th>
            <th class="px-4 py-2 font-medium">Failed</th>
            <th class="px-4 py-2 font-medium">Rate</th>
            <th class="px-4 py-2 font-medium">Avg Duration</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="row in rows" :key="`${row.runtimeKind}-${row.model}`" class="border-t border-white/5">
            <td class="px-4 py-2 text-neutral-300">{{ row.runtimeKind }}</td>
            <td class="px-4 py-2 text-teal-300">{{ row.model }}</td>
            <td class="px-4 py-2">{{ row.total }}</td>
            <td class="px-4 py-2 text-emerald-400">{{ row.success }}</td>
            <td class="px-4 py-2 text-red-400">{{ row.failed }}</td>
            <td class="px-4 py-2">{{ percent(row.successRate) }}</td>
            <td class="px-4 py-2">{{ duration(row.avgDurationMs) }}</td>
          </tr>
        </tbody>
      </table>
    </div>
  </Panel>
</template>
