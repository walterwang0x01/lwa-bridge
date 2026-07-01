<script setup lang="ts">
import { ref, computed } from 'vue';
import type { SkillSummary } from '../types';
import Panel from './Panel.vue';
import EmptyState from './EmptyState.vue';

const props = defineProps<{ skills: SkillSummary[] }>();

const query = ref('');
const filtered = computed(() => {
  const q = query.value.trim().toLowerCase();
  if (!q) return props.skills;
  return props.skills.filter(
    (s) => s.name.toLowerCase().includes(q) || s.description.toLowerCase().includes(q),
  );
});
</script>

<template>
  <Panel title="技能" subtitle="SKILLS · ~/.kiro/skills" :count="skills.length">
    <div class="border-b border-white/5 px-4 py-2">
      <input
        v-model="query"
        type="text"
        placeholder="搜索技能名称或描述…"
        class="w-full rounded-md border border-white/10 bg-white/5 px-3 py-1.5 text-sm text-neutral-200 placeholder:text-neutral-500 focus:border-sky-500/50 focus:outline-none"
      />
    </div>
    <EmptyState v-if="skills.length === 0" text="未检测到 ~/.kiro/skills" />
    <EmptyState v-else-if="filtered.length === 0" text="没有匹配的技能" />
    <div v-else class="max-h-80 divide-y divide-white/5 overflow-y-auto">
      <div v-for="s in filtered" :key="s.dir" class="px-4 py-2.5">
        <code class="text-xs font-medium text-teal-400/90">{{ s.name }}</code>
        <p class="mt-0.5 line-clamp-2 text-xs text-neutral-500">{{ s.description }}</p>
      </div>
    </div>
  </Panel>
</template>
