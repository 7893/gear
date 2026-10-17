import { reactive } from "vue";
import { createClient } from "@supabase/supabase-js";
import { configuration } from "./configuration";

export type Role = "admin" | "operator" | "viewer";
export type MemberStatus = "pending" | "active" | "rejected" | "disabled";
export type Membership = {
  id: string;
  display_name: string;
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
  initializing: true,
  loading: false,
  signedIn: false,
  profile: null as Profile | null,
  message: "",
  error: "",
});
function makeClient(apiUrl: string, publishableKey: string) {
  return createClient(apiUrl, publishableKey, {
    db: { schema: "gear" },
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
const messages: Record<string, string> = {
  admin_required: "当前账号没有管理员权限，请刷新状态。",
  login_required: "请重新登录。",
  email_not_verified: "请先完成邮箱验证。",
  invalid_name: "请填写 1 至 80 个字符的姓名。",
  last_admin: "至少需要保留一个可用的管理员账号。",
  version_conflict: "账号状态已改变，请刷新后重试。",
  request_conflict: "本次请求与此前操作不同，请刷新后重试。",
  invalid_transition: "当前状态不能执行此操作，请刷新后重试。",
  reason_required: "请填写处理原因。",
};
export function safeError(error: unknown): string {
  const message =
    error && typeof error === "object" && "message" in error
      ? String(error.message)
      : "";
  const code =
    error && typeof error === "object" && "code" in error
      ? String(error.code)
      : "";
  if (messages[message]) return messages[message];
  if (["over_email_send_rate_limit", "over_request_rate_limit"].includes(code))
    return "请求较频繁，请稍后再试。";
  if (["otp_expired", "otp_disabled"].includes(code))
    return "验证码已失效，请重新发送。";
  if (code === "email_not_confirmed") return "请先验证邮箱，再登录。";
  return "操作未完成，请稍后重试；若问题持续，请联系管理员。";
}
function service(): ReturnType<typeof makeClient> {
  if (!client || !account.enabled) throw new Error("accounts_unavailable");
  return client;
}
export async function refreshProfile(): Promise<void> {
  if (!client) return;
  const sequence = ++refreshSequence;
  account.loading = true;
  // Clear old permissions before refreshing; errors must not retain an admin view.
  account.profile = null;
  try {
    const { data: session, error: sessionError } =
      await client.auth.getSession();
    if (sequence !== refreshSequence) return;
    if (sessionError) throw sessionError;
    account.signedIn = !!session.session;
    if (!session.session) return;
    const { data, error } = await client.rpc("get_my_membership");
    if (sequence !== refreshSequence) return;
    if (error) throw error;
    const profile = data as Profile;
    const applicationName =
      session.session.user.user_metadata?.gear_application_name;
    if (
      !profile.membership &&
      profile.email_verified &&
      typeof applicationName === "string" &&
      applicationName.trim()
    ) {
      // Registration is an explicit application. Metadata supplies only a name;
      // the RPC checks the verified caller and can create only a pending member.
      const applied = await client.rpc("apply_for_access", {
        display_name: applicationName.trim(),
      });
      if (sequence !== refreshSequence) return;
      if (applied.error) throw applied.error;
      profile.membership = applied.data as Membership;
    }
    account.profile = profile;
    account.error = "";
  } catch (error) {
    if (sequence === refreshSequence) account.error = safeError(error);
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
    if (!account.enabled) return;
    client = makeClient(config.apiUrl, config.publishableKey);
    if (code) {
      const { error } = await client.auth.exchangeCodeForSession(code);
      account.message = error
        ? "验证链接未能完成，请尝试登录或重新验证邮箱。"
        : "邮箱验证已完成。";
    } else if (callbackError)
      account.message = "验证链接无效或已过期，请重新验证邮箱。";
    // Do not await another SDK operation inside an Auth callback's lock.
    client.auth.onAuthStateChange(() => {
      window.setTimeout(() => void refreshProfile(), 0);
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
): Promise<void> {
  const { error } = await service().auth.signUp({
    email: email.trim(),
    password,
    options: {
      data: { gear_application_name: displayName.trim() },
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
export async function apply(displayName: string): Promise<void> {
  const { error } = await service().rpc("apply_for_access", {
    display_name: displayName.trim(),
  });
  if (error) throw error;
  await refreshProfile();
}
export async function signOut(): Promise<void> {
  ++refreshSequence;
  account.profile = null;
  account.signedIn = false;
  const { error } = await service().auth.signOut({ scope: "local" });
  if (error) throw error;
}
export async function listMembers(): Promise<Member[]> {
  const { data, error } = await service().rpc("list_members");
  if (error) throw error;
  return data as Member[];
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
