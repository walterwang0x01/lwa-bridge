<script setup lang="ts">
import Panel from './Panel.vue';
import EmptyState from './EmptyState.vue';

defineProps<{ logs: string[] }>();
</script>

<template>
  <Panel title="最近日志" subtitle="LOGS">
    <EmptyState v-if="logs.length === 0" text="（无日志）" />
    <pre
      v-else
      class="max-h-80 overflow-y-auto whitespace-pre-wrap break-all px-4 py-3 font-mono text-[11px] leading-relaxed text-neutral-400"
      >{{ logs.join('\n') }}</pre
    >
  </Panel>
</template>
