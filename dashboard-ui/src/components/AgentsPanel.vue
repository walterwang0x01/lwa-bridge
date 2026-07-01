<script setup lang="ts">
import { ref, computed } from 'vue';
import type { AgentSummary } from '../types';
import Panel from './Panel.vue';
import EmptyState from './EmptyState.vue';

const props = defineProps<{ agents: AgentSummary[] }>();

const query = ref('');
const filtered = computed(() => {
  const q = query.value.trim().toLowerCase();
  if (!q) return props.agents;
  return props.agents.filter(
    (a) => a.name.toLowerCase().includes(q) || a.promptPreview.toLowerCase().includes(q),
  );
});
</script>

<template>
  <Panel title="角色" subtitle="AGENTS · ~/.kiro/agents" :count="agents.length">
    <div class="border-b border-white/5 px-4 py-2">
      <input
        v-model="query"
        type="text"
        placeholder="搜索角色名称或描述…"
        class="w-full rounded-md border border-white/10 bg-white/5 px-3 py-1.5 text-sm text-neutral-200 placeholder:text-neutral-500 focus:border-sky-500/50 focus:outline-none"
      />
    </div>
    <EmptyState v-if="agents.length === 0" text="未检测到 ~/.kiro/agents" />
    <EmptyState v-else-if="filtered.length === 0" text="没有匹配的角色" />
    <div v-else class="max-h-80 divide-y divide-white/5 overflow-y-auto">
      <div v-for="a in filtered" :key="a.name" class="px-4 py-2.5">
        <code class="text-xs font-medium text-violet-400/90">{{ a.name }}</code>
        <p class="mt-0.5 line-clamp-2 text-xs text-neutral-500">{{ a.promptPreview }}</p>
      </div>
    </div>
  </Panel>
</template>
