<script setup lang="ts">
import { computed } from 'vue';
import { useOverview } from './composables/useOverview';
import { fmtTime } from './lib/format';
import StatBar from './components/StatBar.vue';
import SessionsPanel from './components/SessionsPanel.vue';
import CronPanel from './components/CronPanel.vue';
import ProcessesPanel from './components/ProcessesPanel.vue';
import SkillsPanel from './components/SkillsPanel.vue';
import AgentsPanel from './components/AgentsPanel.vue';
import TaskHistoryPanel from './components/TaskHistoryPanel.vue';
import LogsPanel from './components/LogsPanel.vue';
import RuntimeMetricsPanel from './components/RuntimeMetricsPanel.vue';

const { data, error, lastUpdated } = useOverview();

// "连接"定义：最近一次轮询没报错、且拿到过数据。刚打开页面还没拿到第一次响应时
// 也算未连接（不误报"中断"）。
const connected = computed(() => data.value !== null && error.value === null);
</script>

<template>
  <div class="min-h-screen bg-neutral-950">
    <StatBar :bridge="data?.bridge ?? null" :connected="connected" />

    <main class="mx-auto grid max-w-6xl gap-4 p-6 lg:grid-cols-2">
      <SessionsPanel :sessions="data?.sessions ?? []" />
      <CronPanel :cron="data?.cron ?? []" />
      <ProcessesPanel :processes="data?.processes ?? []" />
      <SkillsPanel :skills="data?.skills ?? []" />
      <AgentsPanel :agents="data?.agents ?? []" />
      <RuntimeMetricsPanel
        :rows="data?.runtimeMetrics ?? []"
        :recommendation="data?.adaptiveRecommendation ?? null"
      />
      <div class="lg:col-span-2">
        <TaskHistoryPanel :tasks="data?.taskHistory ?? []" />
      </div>
      <div class="lg:col-span-2">
        <LogsPanel :logs="data?.logs ?? []" />
      </div>
    </main>

    <footer class="pb-8 text-center text-xs text-neutral-600">
      <span v-if="error" class="text-amber-500">
        刷新失败：{{ error }}（bridge 可能已停）
      </span>
      <span v-else-if="lastUpdated"> 更新于 {{ fmtTime(lastUpdated) }} </span>
    </footer>
  </div>
</template>
