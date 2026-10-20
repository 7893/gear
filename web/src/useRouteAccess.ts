import { computed, type Ref } from "vue";
import { useRoute } from "vue-router";

// Route parameters can change before the previous view is unmounted.
export function useRouteAccess(access: Readonly<Ref<boolean>>) {
  const route = useRoute();
  const view = route.matched.at(-1)?.components?.default;
  return computed(
    () =>
      access.value &&
      !!view &&
      route.matched.at(-1)?.components?.default === view,
  );
}
