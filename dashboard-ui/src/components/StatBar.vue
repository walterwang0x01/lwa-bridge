<script setup lang="ts">
import { computed } from 'vue';
import type { BridgeInfo } from '../types';
import { fmtUptime } from '../lib/format';

const props = defineProps<{
  bridge: BridgeInfo | null;
  connected: boolean;
}>();

const uptime = computed(() => (props.bridge ? fmtUptime(props.bridge.uptimeSec) : '—'));
</script>

<template>
  <header class="flex flex-wrap items-center gap-3 border-b border-white/10 px-6 py-4">
    <h1 class="text-lg font-semibold text-white">LWA 控制台</h1>
    <span
      class="inline-flex items-center gap-1.5 rounded-full border border-white/10 bg-white/5 px-2.5 py-1 text-xs text-neutral-400"
    >
      <span
        class="h-1.5 w-1.5 rounded-full"
        :class="connected ? 'bg-emerald-400' : 'bg-red-400'"
      />
      {{ connected ? '运行中' : '连接中断' }}
    </span>
    <span
      v-if="bridge"
      class="rounded-full border border-white/10 bg-white/5 px-2.5 py-1 text-xs text-neutral-400"
    >
      运行 {{ uptime }}
    </span>
    <span
      v-if="bridge"
      class="rounded-full border border-white/10 bg-white/5 px-2.5 py-1 text-xs text-neutral-400"
    >
      PID {{ bridge.pid }}
    </span>
    <span
      v-if="bridge?.plan"
      class="rounded-full border border-white/10 bg-white/5 px-2.5 py-1 text-xs text-neutral-400"
    >
      plan {{ bridge.plan }}
    </span>
    <span
      v-if="bridge?.defaultRuntime"
      class="rounded-full border border-white/10 bg-white/5 px-2.5 py-1 text-xs text-neutral-400"
    >
      default {{ bridge.defaultRuntime }}
    </span>
    <span
      class="ml-auto rounded-full border border-white/10 bg-white/5 px-2.5 py-1 text-xs text-neutral-500"
    >
      自动刷新 5s
    </span>
  </header>
</template>
