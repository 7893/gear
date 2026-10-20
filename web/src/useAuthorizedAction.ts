import {
  onBeforeUnmount,
  onDeactivated,
  ref,
  watch,
  type Ref,
  type WatchSource,
} from "vue";
import { account, safeError } from "./accounts";

export type AuthorizedOperation<T> = (
  requestId: string,
  signal: AbortSignal,
  isCurrent: () => boolean,
) => Promise<T>;

// Ignore stale results, abort transfers, and reuse a nonce after uncertain replies.
export function useAuthorizedAction(
  access: Readonly<Ref<boolean>>,
  sources: WatchSource[] = [],
  onReset?: () => void,
) {
  const busy = ref(false),
    error = ref("");
  const requests = new Map<string, string>();
  let generation = 0;
  let controller: AbortController | null = null;
  function reset() {
    generation++;
    controller?.abort();
    controller = null;
    requests.clear();
    busy.value = false;
    error.value = "";
    onReset?.();
  }
  watch(
    [
      access,
      () => account.profile?.membership?.id,
      () => account.profile?.membership?.role,
      ...sources,
    ],
    reset,
    { flush: "sync" },
  );
  onBeforeUnmount(reset);
  onDeactivated(reset);
  function requestId(payload: unknown) {
    const key = JSON.stringify(payload);
    if (!requests.has(key)) requests.set(key, crypto.randomUUID());
    return requests.get(key)!;
  }
  async function run<T>(
    payload: unknown,
    action: AuthorizedOperation<T>,
    done: (result: T) => void | Promise<void> = () => {},
    onFailure?: (failure: unknown) => void,
  ) {
    if (!access.value || busy.value) return false;
    const current = generation;
    const isCurrent = () => current === generation && access.value;
    controller = new AbortController();
    busy.value = true;
    error.value = "";
    try {
      const result = await action(
        requestId(payload),
        controller.signal,
        isCurrent,
      );
      if (isCurrent()) {
        await done(result);
        return true;
      }
    } catch (failure) {
      if (isCurrent()) {
        error.value = safeError(failure);
        onFailure?.(failure);
      }
    } finally {
      if (current === generation) {
        busy.value = false;
        controller = null;
      }
    }
    return false;
  }
  return { busy, error, run, reset, requestId };
}
