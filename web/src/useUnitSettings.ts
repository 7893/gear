import { computed, ref, watch } from "vue";
import { account, adminAccess, settingsRpc } from "./accounts";
import {
  getUnitSettings,
  type HeaderInput,
  type DueSettingsInput,
} from "./settings";
import { useAuthorizedQuery } from "./useAuthorizedQuery";
import { useAuthorizedAction } from "./useAuthorizedAction";

// Page-scoped coordinator: one version snapshot and one mutation at a time.
export function useUnitSettings() {
  const query = useAuthorizedQuery(adminAccess, getUnitSettings);
  const action = useAuthorizedAction(adminAccess);
  const notice = ref("");
  const disabled = computed(
    () =>
      !adminAccess.value ||
      !query.data.value ||
      query.loading.value ||
      !!query.error.value ||
      action.busy.value,
  );
  watch(
    [
      adminAccess,
      () => account.profile?.membership?.id,
      () => account.profile?.membership?.role,
    ],
    () => (notice.value = ""),
    { flush: "sync" },
  );
  function save(
    kind: "header" | "due",
    values: HeaderInput | DueSettingsInput,
  ) {
    if (disabled.value || !query.data.value) return Promise.resolve(false);
    const payload = {
      ...values,
      reason: values.reason.trim(),
      expected_version: query.data.value.header.version,
    };
    return action.run(
      { kind, ...payload },
      (id) =>
        settingsRpc(
          kind === "header" ? "update_document_header" : "update_due_settings",
          { ...payload, request_id: id },
        ),
      () => {
        notice.value =
          kind === "header"
            ? "单位抬头已更新，原有单据快照保持。"
            : "提醒设置已保存；不补发历史日期的提醒。";
        void query.refresh();
      },
    );
  }
  return {
    ...query,
    disabled,
    busy: action.busy,
    saveError: action.error,
    notice,
    saveHeader: (values: HeaderInput) =>
      save("header", {
        ...values,
        document_header: values.document_header.trim(),
      }),
    saveDue: (values: DueSettingsInput) => save("due", values),
  };
}
