<script setup lang="ts">
import { ref, computed } from 'vue';
import type { TaskHistoryRecord } from '../types';
import { ago } from '../lib/format';
import Panel from './Panel.vue';
import EmptyState from './EmptyState.vue';

const props = defineProps<{ tasks: TaskHistoryRecord[] }>();

const expanded = ref<Set<string>>(new Set());
function toggle(taskId: string): void {
  if (expanded.value.has(taskId)) expanded.value.delete(taskId);
  else expanded.value.add(taskId);
}

const TERMINAL_LABEL: Record<string, { text: string; dot: string }> = {
  done: { text: '完成', dot: 'bg-emerald-400' },
  error: { text: '出错', dot: 'bg-red-400' },
  interrupted: { text: '已中止', dot: 'bg-amber-400' },
  idle_timeout: { text: '空闲超时', dot: 'bg-amber-400' },
  timeout: { text: '超时', dot: 'bg-amber-400' },
};

function terminalLabel(t: string): { text: string; dot: string } {
  return TERMINAL_LABEL[t] ?? { text: t, dot: 'bg-neutral-500' };
}

function durationSec(t: TaskHistoryRecord): number {
  return Math.round((t.finishedAt - t.startedAt) / 1000);
}

const sorted = computed(() => props.tasks);
</script>

<template>
  <Panel title="任务历史" subtitle="TASKS" :count="tasks.length">
    <EmptyState v-if="tasks.length === 0" text="还没有任务记录" />
    <div v-else class="max-h-96 divide-y divide-white/5 overflow-y-auto">
      <div v-for="t in sorted" :key="t.taskId" class="px-4 py-2.5">
        <button
          type="button"
          class="flex w-full items-start gap-2 text-left"
          @click="toggle(t.taskId)"
        >
          <span :class="['mt-1.5 h-2 w-2 flex-shrink-0 rounded-full', terminalLabel(t.terminal).dot]" />
          <div class="min-w-0 flex-1">
            <p class="truncate text-sm text-neutral-300">{{ t.promptPreview || '（无描述）' }}</p>
            <p class="mt-0.5 text-xs text-neutral-500">
              {{ terminalLabel(t.terminal).text }} · {{ t.toolCallCount }} 次工具调用 ·
              {{ durationSec(t) }}s · {{ ago(t.finishedAt) }}
            </p>
          </div>
        </button>
        <div v-if="expanded.has(t.taskId)" class="mt-2 ml-4 space-y-1 text-xs text-neutral-500">
          <p>目录：<code class="text-neutral-400">{{ t.cwd }}</code></p>
          <p v-if="t.artifacts.length > 0">
            产出文件：
            <span v-for="(f, i) in t.artifacts" :key="f">
              <code class="text-teal-400/80">{{ f }}</code>{{ i < t.artifacts.length - 1 ? '、' : '' }}
            </span>
          </p>
          <p v-if="t.errorMsg" class="text-red-400/80">错误：{{ t.errorMsg }}</p>
        </div>
      </div>
    </div>
  </Panel>
</template>
