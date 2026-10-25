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

const recentResults = new Map<string, { value: unknown; expiresAt: number }>();
const recentResultLifetime = 30_000;

// A short per-user cache lets a list render immediately after navigation while
// the current result is fetched in the background.
export function useAuthorizedQuery<T>(
  access: Readonly<Ref<boolean>>,
  query: (isCurrent: () => boolean) => Promise<T>,
  sources: WatchSource[] = [],
  cacheKey?: string,
) {
  const data = shallowRef<T | null>(null);
  const loading = ref(false);
  const error = ref("");
  let generation = 0;
  let active = true;
  let lastContext: unknown[] | undefined;

  function cacheId() {
    if (!cacheKey || !account.profile?.membership?.id) return;
    return JSON.stringify([
      account.profile.membership.id,
      account.profile.membership.status,
      account.profile.membership.role,
      cacheKey,
      lastContext,
    ]);
  }

  async function execute(retain: boolean, showRecent = false) {
    const current = ++generation;
    if (!account.profile?.membership?.id) recentResults.clear();
    if (!retain || !access.value) data.value = null;
    error.value = "";
    loading.value = false;
    if (!active || !access.value) return;
    const id = cacheId();
    const recent = id && recentResults.get(id);
    if (showRecent && recent && recent.expiresAt > Date.now())
      data.value = recent.value as T;
    loading.value = true;
    const isCurrent = () => active && current === generation && access.value;
    try {
      const result = await query(isCurrent);
      if (isCurrent()) {
        data.value = result;
        if (id && showRecent)
          recentResults.set(id, {
            value: result,
            expiresAt: Date.now() + recentResultLifetime,
          });
      }
    } catch (failure) {
      if (isCurrent()) error.value = safeError(failure);
    } finally {
      if (active && current === generation) loading.value = false;
    }
  }

  // Manual reads remain available to users who need the latest data, while
  // dependent forms can retain their input.
  const load = () => execute(false);
  const refresh = () => execute(true);

  watch(
    [
      access,
      () => account.profile?.membership?.id,
      () => account.profile?.membership?.role,
      ...sources,
    ],
    (context) => {
      // Effects resume when a KeepAlive page becomes visible. Do not turn that
      // lifecycle event into another identical database read.
      if (
        lastContext &&
        context.length === lastContext.length &&
        context.every((value, index) => value === lastContext?.[index])
      )
        return;
      lastContext = [...context];
      void execute(false, true);
    },
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
