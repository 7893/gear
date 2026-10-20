import { computed, reactive } from "vue";
import { clearGearAuthStorage } from "./auth-support";
import { createClient } from "@supabase/supabase-js";
import { configuration } from "./configuration";
import {
  applicationNameError,
  applicationNameMessage,
  applicationPhoneError,
  applicationPhoneMessage,
  validateApplication,
} from "./application-validation";

export type Role = "admin" | "operator" | "viewer";
export type MemberStatus = "pending" | "active" | "rejected" | "disabled";
export type Membership = {
  id: string;
  display_name: string;
  contact_phone?: string | null;
  status: MemberStatus;
  role: Role | null;
  version: number;
  review_note: string | null;
};
export type Profile = {
  email: string;
  email_verified: boolean;
  membership: Membership | null;
};
export type Member = Membership & {
  email: string | null;
  email_verified: boolean;
  identity_exists: boolean;
};
export const account = reactive({
  enabled: false,
  recoveryEnabled: false,
  inventoryEnabled: false,
  flowsEnabled: false,
  evidenceEnabled: false,
  initializing: true,
  loading: false,
  signedIn: false,
  profile: null as Profile | null,
  message: "",
  error: "",
});
export const accountAccess = computed(
  () =>
    account.enabled &&
    account.signedIn &&
    account.profile?.email_verified === true &&
    account.profile.membership?.status === "active" &&
    !!account.profile.membership.role,
);
export const adminAccess = computed(
  () => accountAccess.value && account.profile?.membership?.role === "admin",
);
function makeClient(
  apiUrl: string,
  publishableKey: string,
  databaseSchema: string,
) {
  return createClient(apiUrl, publishableKey, {
    db: { schema: databaseSchema },
    auth: {
      storageKey: "gear.auth.v1",
      flowType: "pkce",
      detectSessionInUrl: false,
      persistSession: true,
      autoRefreshToken: true,
    },
  });
}
let client: ReturnType<typeof makeClient> | undefined;
let refreshSequence = 0;
let profileIdentity: string | undefined;
let profileRefresh: Promise<void> | undefined;

function clearProfile() {
  ++refreshSequence;
  profileRefresh = undefined;
  profileIdentity = undefined;
  account.profile = null;
  account.signedIn = false;
  account.loading = false;
}
const messages: Record<string, string> = {
  evidence_unavailable: "签字件功能尚未开放。",
  invalid_evidence: "附件资料无效，请核对文件、外部单号和更正原因。",
  invalid_evidence_file: "文件无效，请选择完整的 JPEG、PNG 或 PDF 原件。",
  unsupported_evidence_file: "支持 JPEG、PNG 和 PDF；其他格式请转换后再上传。",
  evidence_file_too_large: "单文件最多 20 MiB，请拆分文件后上传。",
  invalid_or_encrypted_pdf:
    "PDF 无法读取或已加密，请检查文件并解除密码后重试。",
  pdf_page_limit_exceeded: "单个 PDF 最多 20 页，请拆分后上传。",
  image_dimensions_exceeded: "图片像素过大，请调整至 4000 万像素以内。",
  invalid_evidence_hints: "识别结果无效，可重新识别或清除结果后人工核对。",
  evidence_document_unavailable:
    "只能为有效正式单据办理签字件，请刷新单据状态。",
  archived_evidence_admin_required: "已归档凭证须由管理员填写原因后更正。",
  duplicate_attachment: "此单已有相同文件，请检查现有附件或待完成上传。",
  evidence_limit_exceeded:
    "每单最多 10 个有效附件，合计 100 MiB；待完成上传也计入限额。",
  attachment_not_found: "附件不存在或当前账号无权读取。",
  attachment_conflict: "附件已变化，请刷新后重新核对。",
  attachment_cancelled: "这次上传已取消，请重新选择文件。",
  upload_incomplete: "上传或读取未完成，可保留文件重试；已上传原件不会被覆盖。",
  evidence_review_required:
    "请核对全部有效附件的签字、单号、内容和页数，先处理待完成上传。",
  evidence_manual_reason_required:
    "未识别或单号不一致，请填写人工核对说明后归档。",

  admin_required: "当前账号没有管理员权限，请刷新状态。",
  login_required: "请重新登录。",
  email_not_verified: "请先完成邮箱验证。",
  invalid_name: "请填写 1 至 80 个字符的姓名。",
  invalid_application_name: applicationNameMessage,
  invalid_contact_phone: applicationPhoneMessage,
  last_admin: "至少需要保留一个可用的管理员账号。",
  version_conflict: "账号状态已改变，请刷新后重试。",
  request_conflict: "本次请求与此前操作不同，请刷新后重试。",
  invalid_transition: "当前状态不能执行此操作，请刷新后重试。",
  reason_required: "请填写处理原因。",
  invalid_verification_code: "请输入六位纯数字验证码。",
  recovery_unavailable: "暂时无法完成密码找回，请稍后重试或联系管理员。",
  recovery_required: "请重新申请并验证找回密码验证码。",
  invalid_new_password: "新密码长度应为 12 至 128 个字符。",
  password_mismatch: "两次输入的新密码不一致。",
  shared_password_confirmation_required: "请先确认共享账号密码变更的影响。",
  invalid_current_password:
    "当前密码不正确，请重新输入；忘记密码可使用邮箱验证码找回。",
  password_change_unavailable: "当前账号状态或身份已变化，请重新登录后核对。",
  password_change_cancelled: "操作已取消，请重新核对账号状态。",
  password_change_busy: "正在处理密码变更，请等待本次请求完成。",
  member_reset_unavailable:
    "此账号尚未验证、未启用或资料已变化，请刷新账号列表后核对。",
  invalid_document_header:
    "请填写一至一百二十字的单行单位抬头和不超过两千字的修改原因。",
  settings_conflict: "设置已变化，请刷新后重新核对修改。",
  settings_unchanged: "单位抬头没有变化，无需保存。",
  inventory_unavailable: "设备台账尚未开放。",
  inventory_access_denied: "当前账号没有此设备操作权限，请刷新账号状态。",
  invalid_asset: "设备资料不符合要求，请核对名称、分类、状况和字段长度。",
  invalid_asset_details: "请核对设备基本资料并填写更正原因，原因不超过两千字。",
  asset_details_conflict:
    "设备资料或流转情况已变化，请刷新设备后重新核对更正。",
  asset_details_unavailable: "无效建账记录不能更正资料，历史记录仍可查阅。",
  asset_details_unchanged: "设备资料没有变化，无需保存更正。",
  invalid_party: "人员或团队资料不符合要求，请核对填写内容。",
  party_not_found: "未找到该人员或团队，请返回名单核对。",
  party_conflict: "人员或团队资料已变化，请刷新后重新核对。",
  party_kind_permanent: "个人与团队的类型不能互相修改，请核对接收对象。",
  party_unchanged: "资料和启用状态没有变化，无需保存。",
  party_default_in_use:
    "此人仍是有效团队的默认负责人，请先更换这些团队的默认负责人。",
  asset_lifecycle_admin_required:
    "只有当前有效管理员可以办理遗失、报废、找回或误建作废。",
  invalid_asset_lifecycle: "请核对处理类型、找回后的实际情况并填写处理原因。",
  invalid_lifecycle_date:
    "日期无效；不能晚于今天或早于已有记录，找回后的期限不能早于找回日期。",
  asset_lifecycle_conflict: "设备情况已变化，请刷新后重新核对。",
  asset_lifecycle_transition:
    "当前设备状态不支持此操作；只有遗失设备可以登记找回。",
  asset_invalidation_dependency:
    "此设备已有流转、处置或关联单据，不能直接作废初始建账，请先核对依赖记录。",
  responsible_person_required:
    "请选择有效的个人负责人；个人持有时负责人应为本人。",
  holder_unavailable: "所选持有方已不可用，请刷新名单后重新选择。",
  invalid_placement: "请核对持有方、使用期限和预计归还日期。",
  invalid_inventory_date: "日期无效；历史起始日期不能晚于业务当天。",
  invalid_inventory_filter: "查询条件无效，请调整后重试。",
  legacy_code_duplicate:
    "已有设备使用相同旧编号，请核对是否为不同实物，再确认继续登记。",
  asset_not_found: "未找到该设备，请返回台账核对。",
  flows_unavailable: "流转办理与单据尚未开放。",
  invalid_due_filter: "请选择有效的到期情况。",
  invalid_extension: "请填写延期原因，长度不超过两千字。",
  invalid_condition_change: "请填写故障说明或维修结果，长度不超过两千字。",
  invalid_condition_date:
    "实际日期须有效，不能晚于东八区今天，也不能早于最近交接或状况变更日期。",
  asset_condition_conflict: "设备情况已变化，请刷新设备情况后重新核对。",
  asset_condition_transition:
    "仅可为在管有效设备登记故障或恢复正常，请刷新核对当前状况。",
  invalid_extension_date: "新期限须晚于原期限，且不能早于东八区今天。",
  assignment_not_temporary: "设备已不属于当前临时领用，请重新读取设备情况。",
  assignment_conflict: "设备或期限已变化，请刷新设备情况后重新核对延期。",
  invalid_party_asset_filter: "请选择适用于当前个人或团队的清单范围。",
  invalid_assignment_user:
    "请选择有效的个人作为具体使用人，并填写不超过两千字的原因。",
  assignment_user_conflict:
    "设备或持有关系已变化，请刷新后重新核对具体使用人。",
  assignment_user_unavailable:
    "仅可补录当前在管、由团队持有的设备；个人持有时使用人为本人。",
  actual_user_unavailable: "所选具体使用人已停用或不存在，请刷新名单重新选择。",
  assignment_user_unchanged: "具体使用人没有变化，无需保存。",
  invalid_document: "单据资料不符合要求，请核对字段与明细数量。",
  invalid_document_item: "请核对设备明细、实际状况；故障设备须填写说明。",
  invalid_document_date:
    "交接日期不能晚于今天，也不能早于设备最近一次流转或故障、维修记录。",
  incomplete_document: "请补齐交接日期、实际移交人、接收人和设备明细。",
  invalid_document_parties: "请核对交接双方、负责人及退回说明。",
  invalid_transfer_parties:
    "普通转交须更换持有方；负责人交接须为同一团队的不同负责人。请核对双方和负责人。",
  document_admin_required: "只有当前有效管理员可以作废或更正正式单据。",
  document_not_confirmed: "仅可处理已确认的正式单据，请刷新后核对。",
  invalid_document_void: "请填写作废原因，长度不超过两千字。",
  invalid_document_correction:
    "请填写更正原因和更正说明，原因不超过两千字，说明不超过四千字。",
  invalid_replacement_document:
    "替代单须为后续确认的同类型正式单据，不能关联自身、草稿或作废单。",
  document_has_dependencies:
    "单据已有后续设备变更或被引用为替代单，不能直接作废。请核对历史，不要倒退真实去向。",
  document_state_conflict:
    "设备当前情况与原单结果不一致，整单未作废，请刷新并核对。",
  reference_not_found: "编号不存在，或当前账号无权查看。",
  document_not_found: "单据不存在，或当前账号无权读取。",
  original_export_too_large:
    "原件合计超过 25 MB 或 1000 份，请使用整体备份工具导出。",
  original_export_empty: "尚无可下载的凭证原件。",
  invalid_inventory_import: "导入文件格式不正确，最多一次导入 200 台设备。",
  inventory_import_row_error: "导入校验未通过，整批未导入。",
  invalid_due_settings: "请检查提醒天数、时间和修改原因。",
  evidence_event_unavailable: "该事件不支持上传凭证，请刷新设备记录。",
  asset_lifecycle_dependencies:
    "该事件已有后续状态变更，不能直接撤销。请先核对历史。",
  draft_access_denied: "只能处理有权访问的草稿，请返回单据列表核对。",
  document_conflict: "单据已被修改或处理，请重新读取后核对。",
  asset_flow_conflict:
    "设备资料、状态或负责人已变化。请刷新设备清单，移除并重新选择冲突设备，再保存草稿。",
  duplicate_document_asset: "同一张单不能重复选择同一台设备。",
};
export function safeError(error: unknown): string {
  if (
    error &&
    typeof error === "object" &&
    "message" in error &&
    error.message === "inventory_import_row_error" &&
    "details" in error &&
    typeof error.details === "string" &&
    error.details.length < 300
  ) {
    try {
      const detail = JSON.parse(error.details) as Record<string, unknown>;
      if (
        Number.isSafeInteger(detail.line_no) &&
        Number(detail.line_no) >= 2 &&
        Number(detail.line_no) <= 201
      )
        return (
          `CSV 第 ${detail.line_no} 行未通过校验，整批未导入。` +
          ((typeof detail.cause === "string" && messages[detail.cause]) ||
            "请核对该行内容。")
        );
    } catch {
      /* Never display arbitrary database detail. */
    }
  }
  const message =
    error && typeof error === "object" && "message" in error
      ? String(error.message)
      : "";
  const code =
    error && typeof error === "object" && "code" in error
      ? String(error.code)
      : "";
  if (messages[message]) {
    let prefix = "";
    if (
      [
        "asset_flow_conflict",
        "invalid_document_date",
        "legacy_code_duplicate",
        "document_has_dependencies",
        "document_state_conflict",
      ].includes(message) &&
      error &&
      typeof error === "object" &&
      "details" in error &&
      typeof error.details === "string" &&
      error.details.length < 160
    ) {
      try {
        const detail = JSON.parse(error.details) as Record<string, unknown>;
        if (
          detail &&
          typeof detail.asset_code === "string" &&
          /^(?:SB-[0-9]{1,19}|EQ-[0-9]{2}-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4})$/.test(
            detail.asset_code,
          )
        )
          prefix = `设备 ${detail.asset_code}：`;
        else if (
          detail &&
          typeof detail.line_no === "number" &&
          Number.isInteger(detail.line_no) &&
          detail.line_no >= 1 &&
          detail.line_no <= 100
        )
          prefix = `第 ${detail.line_no} 件设备：`;
      } catch {
        /* Unexpected diagnostics remain hidden. */
      }
    }
    return prefix + messages[message];
  }
  if (["over_email_send_rate_limit", "over_request_rate_limit"].includes(code))
    return "请求较频繁，请稍后再试。";
  if (["otp_expired", "otp_disabled"].includes(code))
    return "验证码已失效，请重新发送。";
  if (code === "email_not_confirmed") return "请先验证邮箱，再登录。";
  if (code === "same_password") return "新密码需要与原密码不同。";
  if (code === "weak_password") return "新密码不符合要求，请使用更强的密码。";
  return "操作未完成，请稍后重试；若问题持续，请联系管理员。";
}
function service(): ReturnType<typeof makeClient> {
  if (!client || !account.enabled) throw new Error("accounts_unavailable");
  return client;
}
export function refreshProfile(): Promise<void> {
  if (!client) return Promise.resolve();
  if (profileRefresh) return profileRefresh;
  const pending = readProfile().finally(() => {
    if (profileRefresh === pending) profileRefresh = undefined;
  });
  profileRefresh = pending;
  return pending;
}

async function readProfile(): Promise<void> {
  if (!client) return;
  const sequence = ++refreshSequence;
  account.loading = true;
  // Keep a verified same-session view during revalidation. Clear on identity
  // changes or failures; every backend operation still checks current permissions.
  try {
    const { data: session, error: sessionError } =
      await client.auth.getSession();
    if (sequence !== refreshSequence) return;
    if (sessionError) throw sessionError;
    account.signedIn = !!session.session;
    if (!session.session) {
      account.profile = null;
      profileIdentity = undefined;
      return;
    }
    if (profileIdentity !== session.session.user.id) account.profile = null;
    const { data, error } = await client
      .rpc("get_my_membership")
      .abortSignal(AbortSignal.timeout(15000));
    if (sequence !== refreshSequence) return;
    if (error) throw error;
    const profile = data as Profile;
    const applicationName =
      session.session.user.user_metadata?.gear_application_name;
    const applicationPhone =
      session.session.user.user_metadata?.gear_application_phone;
    if (
      !profile.membership &&
      profile.email_verified &&
      typeof applicationName === "string" &&
      typeof applicationPhone === "string" &&
      !applicationNameError(applicationName) &&
      !applicationPhoneError(applicationPhone)
    ) {
      // Metadata is untrusted input. The RPC validates contact details again and
      // can create only a pending Gear member, never a shared Auth phone identity.
      const applied = await client
        .rpc("apply_for_access", {
          display_name: applicationName.trim(),
          contact_phone: applicationPhone,
        })
        .abortSignal(AbortSignal.timeout(15000));
      if (sequence !== refreshSequence) return;
      if (applied.error) throw applied.error;
      profile.membership = applied.data as Membership;
    }
    profileIdentity = session.session.user.id;
    account.profile = profile;
    account.error = "";
  } catch (error) {
    if (sequence === refreshSequence) {
      account.profile = null;
      profileIdentity = undefined;
      account.error = safeError(error);
    }
  } finally {
    if (sequence === refreshSequence) account.loading = false;
  }
}
export async function initializeAccounts(): Promise<void> {
  const callback = new URL(window.location.href);
  const code = callback.searchParams.get("code");
  const callbackError =
    callback.searchParams.has("error") ||
    callback.hash.includes("access_token=");
  if (code || callbackError) {
    for (const key of ["code", "error", "error_code", "error_description"])
      callback.searchParams.delete(key);
    callback.hash = "#/";
    window.history.replaceState(
      null,
      "",
      callback.pathname + callback.search + callback.hash,
    );
  }
  try {
    const config = await configuration();
    account.enabled = config.accountsEnabled;
    account.recoveryEnabled = config.recoveryEnabled;
    account.inventoryEnabled = config.inventoryEnabled;
    account.flowsEnabled = config.flowsEnabled;
    account.evidenceEnabled = config.evidenceEnabled;
    if (!account.enabled) return;
    client = makeClient(
      config.apiUrl,
      config.publishableKey,
      config.databaseSchema,
    );
    if (code) {
      const { error } = await client.auth.exchangeCodeForSession(code);
      account.message = error
        ? "验证链接未能完成，请尝试登录或重新验证邮箱。"
        : "邮箱验证已完成。";
    } else if (callbackError)
      account.message = "验证链接无效或已过期，请重新验证邮箱。";
    // Do not await another SDK operation inside an Auth callback's lock.
    client.auth.onAuthStateChange((event, session) => {
      if (event === "SIGNED_OUT") {
        clearProfile();
        return;
      }
      if (event === "INITIAL_SESSION") return; // Explicit check below owns startup.
      if (session && session.user.id !== profileIdentity) clearProfile();
      window.setTimeout(() => {
        // signIn/verifyEmail also check explicitly; avoid a second identical read.
        if (event === "SIGNED_IN" && profileIdentity === session?.user.id)
          return;
        void refreshProfile();
      }, 0);
    });
    await refreshProfile();
    window.addEventListener("focus", () => void refreshProfile());
  } catch {
    account.error = "暂时无法连接服务，请稍后刷新。";
  } finally {
    account.initializing = false;
  }
}
export async function signIn(email: string, password: string): Promise<void> {
  const { error } = await service().auth.signInWithPassword({
    email: email.trim(),
    password,
  });
  if (error) throw error;
  await refreshProfile();
}
export async function register(
  displayName: string,
  email: string,
  password: string,
  contactPhone: string,
): Promise<void> {
  const application = validateApplication(displayName, contactPhone);
  const { error } = await service().auth.signUp({
    email: email.trim(),
    password,
    options: {
      data: {
        gear_application_name: application.display_name,
        gear_application_phone: application.contact_phone,
      },
      emailRedirectTo: window.location.origin + "/",
    },
  });
  if (
    error &&
    !["user_already_exists", "email_exists"].includes(error.code || "")
  )
    throw error;
}
export async function verifyEmail(email: string, token: string): Promise<void> {
  if (!/^[0-9]{6}$/.test(token.trim()))
    throw new Error("invalid_verification_code");
  const { error } = await service().auth.verifyOtp({
    email: email.trim(),
    token: token.trim(),
    type: "signup",
  });
  if (error) throw error;
  await refreshProfile();
}
export async function resendVerification(email: string): Promise<void> {
  const { error } = await service().auth.resend({
    type: "signup",
    email: email.trim(),
    options: { emailRedirectTo: window.location.origin + "/" },
  });
  if (error) throw error;
}
export async function apply(
  displayName: string,
  contactPhone: string,
): Promise<void> {
  const application = validateApplication(displayName, contactPhone);
  const { error } = await service().rpc("apply_for_access", application);
  if (error) throw error;
  await refreshProfile();
}
export async function signOut(): Promise<void> {
  clearProfile();
  const { error } = await service().auth.signOut({ scope: "local" });
  if (error) throw error;
}
export async function listMembers(): Promise<Member[]> {
  const { data, error } = await service().rpc("list_members");
  if (error) throw error;
  return data as Member[];
}
export async function freshAccountIdentity() {
  if (!accountAccess.value) throw new Error("password_change_unavailable");
  const current = service();
  const { data, error } = await current.auth.getUser();
  if (error || !data.user?.email || !data.user.email_confirmed_at)
    throw new Error("password_change_unavailable");
  const result = await current.rpc("get_my_membership");
  const profile = result.data as Profile | null;
  if (
    result.error ||
    !profile?.email_verified ||
    profile.membership?.status !== "active" ||
    !profile.membership.role ||
    profile.email.toLowerCase() !== data.user.email.toLowerCase() ||
    !accountAccess.value ||
    profile.membership.id !== account.profile?.membership?.id
  )
    throw new Error("password_change_unavailable");
  return {
    id: data.user.id,
    email: data.user.email,
    memberId: profile.membership.id,
    role: profile.membership.role,
  };
}
export async function finishPasswordChange(identityId: string) {
  const { data } = await service().auth.getSession();
  if (data.session?.user.id !== identityId) return;
  await signOut().catch(() => undefined);
  clearGearAuthStorage();
}
export async function requestMemberPasswordReset(member: Member) {
  if (!account.enabled || !account.recoveryEnabled || !adminAccess.value)
    throw new Error("admin_required");
  const identity = await freshAccountIdentity();
  if (identity.role !== "admin") throw new Error("admin_required");
  const latest = (await listMembers()).find((item) => item.id === member.id);
  if (
    !latest ||
    latest.version !== member.version ||
    latest.email !== member.email ||
    !latest.email ||
    !latest.email_verified ||
    !latest.identity_exists ||
    latest.status !== "active"
  )
    throw new Error("member_reset_unavailable");
  const current = await freshAccountIdentity();
  if (
    !adminAccess.value ||
    current.role !== "admin" ||
    current.id !== identity.id ||
    current.memberId !== identity.memberId
  )
    throw new Error("admin_required");
  // This is the existing public recovery operation; the server email hook
  // independently checks the target's current eligibility before sending.
  const { error } = await service().auth.resetPasswordForEmail(latest.email, {
    redirectTo: window.location.origin + "/",
  });
  if (error) throw error;
}
async function databaseRpc(
  name: string,
  parameters: Record<string, unknown>,
): Promise<unknown> {
  const { data, error } = await service()
    .rpc(name, parameters)
    .abortSignal(AbortSignal.timeout(15000));
  if (error) throw error;
  return data;
}
export async function settingsRpc(
  name:
    | "get_app_settings"
    | "update_document_header"
    | "get_due_settings"
    | "update_due_settings",
  parameters: Record<string, unknown> = {},
): Promise<unknown> {
  if (!adminAccess.value) throw new Error("admin_required");
  return databaseRpc(name, parameters);
}
export async function inventoryRpc(
  name:
    | "import_assets"
    | "correct_asset_lifecycle"
    | "list_event_evidence"
    | "reserve_event_attachment"
    | "review_event_attachment"
    | "list_originals"
    | "list_assets"
    | "get_asset"
    | "list_parties"
    | "create_party"
    | "resolve_reference"
    | "list_party_records"
    | "list_party_assets"
    | "set_assignment_user"
    | "get_party"
    | "update_party"
    | "change_asset_lifecycle"
    | "initialize_asset"
    | "list_due_assets"
    | "extend_assignment"
    | "change_asset_condition"
    | "update_asset_details"
    | "list_documents"
    | "get_document"
    | "save_document"
    | "delete_document"
    | "confirm_document"
    | "void_document"
    | "correct_document"
    | "list_evidence"
    | "get_attachment"
    | "match_evidence"
    | "reserve_attachment"
    | "cancel_attachment"
    | "update_attachment"
    | "archive_evidence",
  parameters: Record<string, unknown> = {},
): Promise<unknown> {
  if (!account.inventoryEnabled) throw new Error("inventory_unavailable");
  if (name.endsWith("document") || name === "list_documents") {
    if (!account.flowsEnabled) throw new Error("flows_unavailable");
  }
  if (
    [
      "list_event_evidence",
      "reserve_event_attachment",
      "review_event_attachment",
      "list_originals",
      "list_evidence",
      "get_attachment",
      "match_evidence",
      "reserve_attachment",
      "cancel_attachment",
      "update_attachment",
      "archive_evidence",
    ].includes(name) &&
    (!account.evidenceEnabled || !account.flowsEnabled)
  )
    throw new Error("evidence_unavailable");
  return databaseRpc(name, parameters);
}
export type NotificationStatus = {
  enabled: boolean;
  counts: Partial<
    Record<
      | "pending"
      | "processing"
      | "submitted"
      | "failed"
      | "unknown"
      | "cancelled",
      number
    >
  >;
  recent: {
    id: string;
    notification_type:
      "application_pending" | "application_result" | "daily_due";
    status: keyof NotificationStatus["counts"];
    attempt_count: number;
    error_code: string | null;
    updated_at: string;
  }[];
};
export async function getNotificationStatus(): Promise<NotificationStatus> {
  const { data, error } = await service().rpc("notification_status");
  if (error) throw error;
  return data as NotificationStatus;
}
export async function setMemberAccess(
  member: Member,
  status: MemberStatus,
  role: Role | null,
  reason: string,
  requestId: string,
): Promise<void> {
  const { error } = await service().rpc("set_member_access", {
    target_member_id: member.id,
    expected_version: member.version,
    new_status: status,
    new_role: role,
    reason: reason.trim(),
    request_id: requestId,
  });
  if (error) throw error;
}
export const roleLabels = {
  admin: "管理员",
  operator: "经办人",
  viewer: "查询人",
};
export const statusLabels = {
  pending: "待审核",
  active: "已启用",
  rejected: "已拒绝",
  disabled: "已停用",
};

export async function evidenceRequest(options: {
  body?: FormData;
  attachmentId?: string;
  signal?: AbortSignal;
}): Promise<Response> {
  if (
    !account.evidenceEnabled ||
    !account.flowsEnabled ||
    !account.inventoryEnabled
  )
    throw new Error("evidence_unavailable");
  const { data, error } = await service().auth.getSession();
  if (error || !data.session) throw new Error("login_required");
  const config = await configuration();
  const url = new URL(config.apiUrl + "/functions/v1/gear-evidence");
  if (options.attachmentId)
    url.searchParams.set("attachment_id", options.attachmentId);
  const response = await fetch(url, {
    method: options.body ? "POST" : "GET",
    headers: {
      apikey: config.publishableKey,
      Authorization: "Bearer " + data.session.access_token,
    },
    body: options.body,
    cache: "no-store",
    signal: AbortSignal.any([
      AbortSignal.timeout(120000),
      ...(options.signal ? [options.signal] : []),
    ]),
  });
  if (!response.ok) {
    const result = (await response.json().catch(() => ({}))) as {
      error?: string;
    };
    throw new Error(result.error || "upload_incomplete");
  }
  return response;
}
