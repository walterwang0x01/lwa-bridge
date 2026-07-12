import { ref, onMounted, onUnmounted } from 'vue';
import type { Overview } from '../types';

const POLL_MS = 5000;

/**
 * 轮询 /api/overview，5s 一次。组件卸载时清定时器。
 * 失败不清空已有数据（避免页面在瞬时错误时闪空），只把 error 亮出来。
 */
export function useOverview() {
  const data = ref<Overview | null>(null);
  const error = ref<string | null>(null);
  const lastUpdated = ref<number | null>(null);
  const actionError = ref<string | null>(null);

  let timer: ReturnType<typeof setInterval> | undefined;

  async function fetchOnce(): Promise<void> {
    try {
      const res = await fetch('/api/overview');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      data.value = (await res.json()) as Overview;
      error.value = null;
      lastUpdated.value = Date.now();
    } catch (e) {
      error.value = e instanceof Error ? e.message : String(e);
    }
  }

  async function setSessionRuntime(conversationId: string, profileName: string): Promise<boolean> {
    actionError.value = null;
    try {
      const res = await fetch('/api/session/runtime', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ conversationId, profileName }),
      });
      const json = (await res.json()) as { ok?: boolean; error?: string };
      if (!res.ok || !json.ok) {
        actionError.value = json.error ?? `HTTP ${res.status}`;
        return false;
      }
      await fetchOnce();
      return true;
    } catch (e) {
      actionError.value = e instanceof Error ? e.message : String(e);
      return false;
    }
  }

  onMounted(() => {
    void fetchOnce();
    timer = setInterval(() => void fetchOnce(), POLL_MS);
  });

  onUnmounted(() => {
    if (timer) clearInterval(timer);
  });

  return { data, error, lastUpdated, actionError, setSessionRuntime };
}
