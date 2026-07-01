<script setup lang="ts">
defineProps<{ text?: string }>();
</script>

<template>
  <div class="px-4 py-6 text-center text-sm text-neutral-500">
    {{ text ?? '（无）' }}
  </div>
</template>
