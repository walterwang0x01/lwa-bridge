<script setup lang="ts">
/**
 * 统一卡片外壳：标题 + 可选副标题 + 内容插槽。
 * 所有面板（Sessions/Cron/Processes/Skills/Logs）都用这个包一层，
 * 保证圆角/边框/间距一致，不用每个面板重复写容器样式。
 */
defineProps<{
  title: string;
  subtitle?: string;
  count?: number;
}>();
</script>

<template>
  <section
    class="rounded-xl border border-white/10 bg-white/[0.03] backdrop-blur-sm overflow-hidden"
  >
    <header class="flex items-center gap-2 px-4 py-3 border-b border-white/10">
      <h2 class="text-sm font-semibold text-neutral-200 tracking-wide">{{ title }}</h2>
      <span v-if="subtitle" class="text-xs text-neutral-500">{{ subtitle }}</span>
      <span
        v-if="count !== undefined"
        class="ml-auto rounded-full bg-white/10 px-2 py-0.5 text-xs font-medium text-neutral-300"
      >
        {{ count }}
      </span>
    </header>
    <div>
      <slot />
    </div>
  </section>
</template>
