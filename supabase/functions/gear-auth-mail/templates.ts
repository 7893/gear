export type MailContent = { subject: string; text: string };
export type CodePurpose = "signup" | "recovery" | "reauthentication";

const codePurposes: Record<
  CodePurpose,
  { title: string; instruction: string }
> = {
  signup: {
    title: "验证注册邮箱",
    instruction:
      "请返回设备簿，在验证邮箱页面输入这六位数字。验证完成后，使用申请仍需管理员审核。",
  },
  recovery: {
    title: "找回登录密码",
    instruction:
      "请返回设备簿，在找回密码页面输入这六位数字，验证通过后再设置新密码。本邮件不会直接修改密码。",
  },
  reauthentication: {
    title: "确认本人操作",
    instruction: "请返回设备簿，在确认操作页面输入这六位数字。",
  },
};

export function renderGearCodeEmail(
  purpose: CodePurpose,
  code: string,
): MailContent {
  if (!/^[0-9]{6}$/.test(code)) throw new Error("invalid_token");
  const { title, instruction } = codePurposes[purpose];
  return {
    subject: `【设备簿】${title}`,
    text: [
      title,
      "",
      `验证码：${code}`,
      "",
      instruction,
      "验证码仅用于本次操作，只能使用一次；如已失效，请在对应页面重新发送。",
      "请勿向他人提供验证码。如果不是您本人发起，请忽略此邮件。",
    ].join("\n"),
  };
}

type Role = "admin" | "operator" | "viewer";
const roles: Record<Role, string> = {
  admin: "管理员",
  operator: "经办人",
  viewer: "查询人",
};
export type Notification =
  | { kind: "application_pending"; applicantName: string }
  | { kind: "application_approved"; role: Role }
  | { kind: "application_rejected" }
  | { kind: "password_changed" }
  | { kind: "access_disabled" }
  | { kind: "access_restored"; role: Role }
  | {
      kind: "daily_due";
      businessDate: string;
      dueSoon: number;
      dueToday: number;
      overdue: number;
    };

// Pure content rendering only. The sender must resolve recipients and recheck
// current membership, notification eligibility and event state before delivery.
export function renderGearNotification(
  notification: Notification,
  appOrigin: string,
): MailContent {
  const url = new URL(appOrigin);
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  )
    throw new Error("invalid_app_origin");
  let title: string;
  let lines: string[];
  url.hash = "/";
  switch (notification.kind) {
    case "application_pending":
      title = "有新的使用申请待审核";
      lines = [
        `申请人：${notification.applicantName}`,
        "该申请人已完成邮箱验证，请登录账号管理核对身份并审核。",
        "此邮件不代表申请已批准。",
      ];
      url.hash = "/members";
      break;
    case "application_approved":
      title = "使用申请已通过";
      lines = [
        "你的使用申请已通过管理员审核。",
        `当前权限：${roles[notification.role]}`,
        "请使用注册邮箱和原密码登录，邮件不包含密码。",
      ];
      break;
    case "application_rejected":
      title = "使用申请未通过";
      lines = [
        "你的使用申请未通过管理员审核。",
        "请登录查看处理说明；如需重新申请，请联系管理员。",
      ];
      break;
    case "password_changed":
      title = "登录密码已更改";
      lines = [
        "你的登录密码已更改。",
        "如果不是你本人操作，请尽快通过正常找回流程保护账号并联系管理员。",
      ];
      break;
    case "access_disabled":
      title = "账号使用权限已停用";
      lines = [
        "你在设备簿的使用权限已停用，请登录查看状态或联系管理员。",
        "停用不代表设备已经退回，已领用设备仍需按实际交接办理。",
      ];
      break;
    case "access_restored":
      title = "账号使用权限已恢复";
      lines = [
        "你在设备簿的使用权限已恢复。",
        `当前权限：${roles[notification.role]}`,
        "请登录查看当前状态。",
      ];
      break;
    case "daily_due":
      title = "临时使用到期提醒";
      if (
        !/^\d{4}-\d{2}-\d{2}$/.test(notification.businessDate) ||
        ![
          notification.dueSoon,
          notification.dueToday,
          notification.overdue,
        ].every((count) => Number.isSafeInteger(count) && count >= 0) ||
        notification.dueSoon + notification.dueToday + notification.overdue ===
          0
      )
        throw new Error("invalid_due_summary");
      lines = [
        `业务日期：${notification.businessDate}（东八区）`,
        "以下仅统计本次到达提醒节点的设备，完整清单请登录查看。",
        `即将到期：${notification.dueSoon} 件`,
        `今日到期：${notification.dueToday} 件`,
        `已经逾期：${notification.overdue} 件`,
        "请登录查看并办理归还或延期，已完成处理的设备以系统当前记录为准。",
      ];
      break;
  }
  return {
    subject: `【设备簿】${title}`,
    text: [
      title,
      "",
      ...lines,
      "",
      "登录设备簿查看：",
      url.toString(),
      "",
      "邮件仅作通知，具体权限、设备状态及办理结果以系统记录为准。",
    ].join("\n"),
  };
}
