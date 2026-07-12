<script setup lang="ts">
import { computed } from 'vue';
import { useOverview } from './composables/useOverview';
import { fmtTime } from './lib/format';
import StatBar from './components/StatBar.vue';
import SessionsPanel from './components/SessionsPanel.vue';
import ConduitPanel from './components/ConduitPanel.vue';
import CronPanel from './components/CronPanel.vue';
import ProcessesPanel from './components/ProcessesPanel.vue';
import SkillsPanel from './components/SkillsPanel.vue';
import AgentsPanel from './components/AgentsPanel.vue';
import TaskHistoryPanel from './components/TaskHistoryPanel.vue';
import LogsPanel from './components/LogsPanel.vue';
import RuntimeMetricsPanel from './components/RuntimeMetricsPanel.vue';

const { data, error, lastUpdated, actionError, setSessionRuntime } = useOverview();

const connected = computed(() => data.value !== null && error.value === null);

async function onSetRuntime(payload: { conversationId: string; profileName: string }) {
  await setSessionRuntime(payload.conversationId, payload.profileName);
}
</script>

<template>
  <div class="min-h-screen bg-neutral-950">
    <StatBar :bridge="data?.bridge ?? null" :connected="connected" />

    <main class="mx-auto grid max-w-6xl gap-4 p-6 lg:grid-cols-2">
      <SessionsPanel :sessions="data?.sessions ?? []" @set-runtime="onSetRuntime" />
      <ConduitPanel
        :active="data?.conduitActive ?? []"
        :recent="data?.conduitRecent ?? []"
      />
      <CronPanel :cron="data?.cron ?? []" />
      <ProcessesPanel :processes="data?.processes ?? []" />
      <SkillsPanel :skills="data?.skills ?? []" />
      <AgentsPanel :agents="data?.agents ?? []" />
      <RuntimeMetricsPanel
        :rows="data?.runtimeMetrics ?? []"
        :recommendation="data?.adaptiveRecommendation ?? null"
        :readiness="data?.adaptiveReadiness ?? []"
        :alerts="data?.metricsAlerts ?? []"
        :profiles="data?.runtimeProfiles ?? []"
        :quotas="data?.quotaStatuses ?? []"
      />
      <div class="lg:col-span-2">
        <TaskHistoryPanel :tasks="data?.taskHistory ?? []" />
      </div>
      <div class="lg:col-span-2">
        <LogsPanel :logs="data?.logs ?? []" />
      </div>
    </main>

    <footer class="pb-8 text-center text-xs text-neutral-600">
      <span v-if="actionError" class="text-rose-400">操作失败：{{ actionError }} · </span>
      <span v-if="error" class="text-amber-500">
        刷新失败：{{ error }}（bridge 可能已停）
      </span>
      <span v-else-if="lastUpdated"> 更新于 {{ fmtTime(lastUpdated) }} </span>
    </footer>
  </div>
</template>
