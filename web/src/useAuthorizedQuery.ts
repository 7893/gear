import {
  onBeforeUnmount,
  ref,
  shallowRef,
  watch,
  type Ref,
  type WatchSource,
} from "vue";
import { account, safeError } from "./accounts";

// One result per authorized page context; no shared cache of private data.
export function useAuthorizedQuery<T>(
  access: Readonly<Ref<boolean>>,
  query: () => Promise<T>,
  sources: WatchSource[] = [],
) {
  const data = shallowRef<T | null>(null);
  const loading = ref(false);
  const error = ref("");
  let generation = 0;
  let active = true;

  async function load() {
    const current = ++generation;
    data.value = null;
    error.value = "";
    loading.value = false;
    if (!active || !access.value) return;
    loading.value = true;
    try {
      const result = await query();
      if (active && current === generation && access.value) data.value = result;
    } catch (failure) {
      if (active && current === generation && access.value)
        error.value = safeError(failure);
    } finally {
      if (active && current === generation) loading.value = false;
    }
  }

  watch(
    [
      access,
      () => account.profile?.membership?.id,
      () => account.profile?.membership?.role,
      ...sources,
    ],
    () => void load(),
    { immediate: true, flush: "sync" },
  );
  onBeforeUnmount(() => {
    active = false;
    generation++;
  });
  return { data, loading, error, load };
}
