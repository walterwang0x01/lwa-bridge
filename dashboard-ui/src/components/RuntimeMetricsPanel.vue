<script setup lang="ts">
import type {
  AdaptiveBucketReadiness,
  AdaptiveRecommendation,
  MetricsAlertRow,
  RuntimeMetricsRow,
} from '../types';
import Panel from './Panel.vue';
import EmptyState from './EmptyState.vue';

defineProps<{
  rows: RuntimeMetricsRow[];
  recommendation?: AdaptiveRecommendation | null;
  readiness?: AdaptiveBucketReadiness[];
  alerts?: MetricsAlertRow[];
}>();

function percent(v: number): string {
  return `${Math.round(v * 100)}%`;
}

function duration(ms: number): string {
  return `${Math.round(ms / 1000)}s`;
}

function score(v: number): string {
  return v.toFixed(2);
}

function isDegraded(row: RuntimeMetricsRow, alerts: MetricsAlertRow[] | undefined): boolean {
  return (
    alerts?.some(
      (a) =>
        a.taskBucket === row.taskBucket &&
        a.runtimeKind === row.runtimeKind &&
        a.model === row.model,
    ) ?? false
  );
}
</script>

<template>
  <Panel title="Runtime 指标" subtitle="METRICS" :count="rows.length">
    <div
      v-if="readiness && readiness.some((r) => r.sampleSize > 0)"
      class="border-b border-white/5 bg-white/[0.02] px-4 py-2 text-xs text-neutral-400"
    >
      <div class="mb-1 font-medium text-neutral-500">apply-safe 就绪（每桶）</div>
      <div class="flex flex-wrap gap-2">
        <span
          v-for="item in readiness.filter((r) => r.sampleSize > 0)"
          :key="item.taskBucket"
          class="rounded border px-2 py-0.5"
          :class="
            item.rolloutReady
              ? 'border-emerald-500/40 text-emerald-300'
              : item.canApplyRuntime
                ? 'border-amber-500/40 text-amber-300'
                : 'border-white/10 text-neutral-500'
          "
        >
          {{ item.taskBucket }}: n={{ item.sampleSize }}
          <template v-if="item.rolloutReady">· 可切 apply-safe</template>
          <template v-else-if="item.canApplyRuntime">· 门禁已过·样本&lt;30</template>
          <template v-else>· 未就绪</template>
        </span>
      </div>
    </div>
    <div
      v-if="alerts && alerts.length > 0"
      class="border-b border-red-500/20 bg-red-500/5 px-4 py-2 text-xs text-red-300"
    >
      告警：{{ alerts.length }} 组成功率 &lt; 75%（样本≥3）— 检查 runtime/model 是否劣化
    </div>
    <div
      v-if="recommendation && recommendation.sampleSize > 0"
      class="border-b border-white/5 bg-white/[0.02] px-4 py-2 text-xs text-neutral-400"
    >
      推荐：
      runtime=<span class="text-neutral-200">{{ recommendation.preferredRuntimeKind || '保持当前' }}</span>
      · model=<span class="text-teal-300">{{ recommendation.preferredModel || '保持当前' }}</span>
      · score=<span class="text-amber-300">{{
        recommendation.runtimeScore != null ? score(recommendation.runtimeScore) : '-'
      }}</span>
      · samples={{ recommendation.sampleSize }}
    </div>
    <EmptyState v-if="rows.length === 0" text="还没有 runtime 指标" />
    <div v-else class="overflow-x-auto">
      <table class="min-w-full text-left text-xs text-neutral-400">
        <thead class="bg-white/[0.02] text-neutral-500">
          <tr>
            <th class="px-4 py-2 font-medium">Bucket</th>
            <th class="px-4 py-2 font-medium">Runtime</th>
            <th class="px-4 py-2 font-medium">Model</th>
            <th class="px-4 py-2 font-medium">Score</th>
            <th class="px-4 py-2 font-medium">Total</th>
            <th class="px-4 py-2 font-medium">Success</th>
            <th class="px-4 py-2 font-medium">Failed</th>
            <th class="px-4 py-2 font-medium">Rate</th>
            <th class="px-4 py-2 font-medium">Avg Duration</th>
          </tr>
        </thead>
        <tbody>
          <tr
            v-for="row in rows"
            :key="`${row.taskBucket}-${row.runtimeKind}-${row.model}`"
            class="border-t border-white/5"
            :class="isDegraded(row, alerts) ? 'bg-red-500/5' : ''"
          >
            <td class="px-4 py-2 text-violet-300">{{ row.taskBucket }}</td>
            <td class="px-4 py-2 text-neutral-300">{{ row.runtimeKind }}</td>
            <td class="px-4 py-2 text-teal-300">{{ row.model }}</td>
            <td class="px-4 py-2 text-amber-300">{{ score(row.score) }}</td>
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
