// Contact details belong to Gear membership, not shared Auth phone identities.
export const mainlandMobilePattern = "1[3-9][0-9]{9}";
export const applicationNameMessage =
  "请填写 2 至 80 个字符的本人姓名，不使用占位名、测试内容、数字或特殊符号。";
export const applicationPhoneMessage =
  "请输入中国大陆 11 位手机号码，以 13 至 19 开头，仅接受半角数字。";

export function applicationNameError(value: string): string {
  const name = value.trim();
  if (
    Array.from(name).length < 2 ||
    Array.from(name).length > 80 ||
    !/^[A-Za-zÀ-ÖØ-öø-ɏḀ-ỿ一-鿿㐀-䶿]+(?:[ ·•・'’-][A-Za-zÀ-ÖØ-öø-ɏḀ-ỿ一-鿿㐀-䶿]+)*$/u.test(
      name,
    ) ||
    /^(张三|测试(?:用户|账号|姓名|人员)?|姓名|真实姓名|你的姓名|请输入姓名|匿名|无名氏|管理员|test(?:user)?|admin|administrator|unknown|anonymous|null|undefined)$/iu.test(
      name.replace(/ /g, ""),
    )
  )
    return applicationNameMessage;
  return "";
}

export function applicationPhoneError(value: string): string {
  return value.length === 11 &&
    new RegExp(`^${mainlandMobilePattern}$`).test(value)
    ? ""
    : applicationPhoneMessage;
}

export function validateApplication(displayName: string, contactPhone: string) {
  if (applicationNameError(displayName))
    throw new Error("invalid_application_name");
  if (applicationPhoneError(contactPhone))
    throw new Error("invalid_contact_phone");
  return { display_name: displayName.trim(), contact_phone: contactPhone };
}
