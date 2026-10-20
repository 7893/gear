import {
  onBeforeUnmount,
  onActivated,
  onDeactivated,
  ref,
  shallowRef,
  watch,
  type Ref,
  type WatchSource,
} from "vue";
import { account, safeError } from "./accounts";

// Results belong to one authorized view; KeepAlive may retain that view in memory.
export function useAuthorizedQuery<T>(
  access: Readonly<Ref<boolean>>,
  query: (isCurrent: () => boolean) => Promise<T>,
  sources: WatchSource[] = [],
) {
  const data = shallowRef<T | null>(null);
  const loading = ref(false);
  const error = ref("");
  let generation = 0;
  let active = true;

  async function execute(retain: boolean) {
    const current = ++generation;
    if (!retain || !access.value) data.value = null;
    error.value = "";
    loading.value = false;
    if (!active || !access.value) return;
    loading.value = true;
    const isCurrent = () => active && current === generation && access.value;
    try {
      const result = await query(isCurrent);
      if (isCurrent()) data.value = result;
    } catch (failure) {
      if (isCurrent()) error.value = safeError(failure);
    } finally {
      if (active && current === generation) loading.value = false;
    }
  }

  // Retain drafts during a same-context refresh; authorization changes always clear.
  const load = () => execute(false);
  const refresh = () => execute(true);

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
  watch(
    () => account.profile,
    (profile, previous) => {
      // A successful same-identity permission check refreshes visible data
      // without clearing the view. Identity/role changes use load() above.
      if (
        active &&
        profile &&
        previous &&
        profile.email === previous.email &&
        profile.email_verified === previous.email_verified &&
        profile.membership?.id === previous.membership?.id &&
        profile.membership?.status === previous.membership?.status &&
        profile.membership?.role === previous.membership?.role
      )
        void refresh();
    },
    { flush: "sync" },
  );
  onDeactivated(() => {
    active = false;
    generation++;
    loading.value = false;
  });
  onActivated(() => {
    if (active) return; // First activation already loaded via the watcher.
    active = true;
    void refresh();
  });
  onBeforeUnmount(() => {
    active = false;
    generation++;
  });
  return { data, loading, error, load, refresh };
}
