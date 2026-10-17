type RuntimeConfig = { apiUrl: string; publishableKey: string };

const page = document.querySelector<HTMLLIElement>("#page-status")!;
const gateway = document.querySelector<HTMLLIElement>("#gateway-status")!;
const supabase = document.querySelector<HTMLLIElement>("#supabase-status")!;
const retry = document.querySelector<HTMLButtonElement>("#retry")!;
const checkedAt = document.querySelector<HTMLParagraphElement>("#checked-at")!;

page.textContent = "页面脚本：正常（TypeScript 已构建运行）";
page.dataset.state = "success";

async function readJson(url: string | URL, headers?: HeadersInit) {
  const response = await fetch(url, {
    headers,
    cache: "no-store",
    signal: AbortSignal.timeout(10000),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return (await response.json()) as unknown;
}

async function configuration(): Promise<RuntimeConfig> {
  const value = await readJson("/runtime-config.json");
  if (
    !value ||
    typeof value !== "object" ||
    !("apiUrl" in value) ||
    typeof value.apiUrl !== "string" ||
    !("publishableKey" in value) ||
    typeof value.publishableKey !== "string" ||
    !value.publishableKey.startsWith("sb_publishable_")
  )
    throw new Error("配置无效");
  const url = new URL(value.apiUrl);
  if (url.protocol !== "https:" || url.username || url.password)
    throw new Error("配置无效");
  return { apiUrl: url.origin, publishableKey: value.publishableKey };
}

async function check(
  element: HTMLElement,
  label: string,
  operation: () => Promise<void>,
) {
  element.textContent = `${label}：检测中`;
  element.dataset.state = "pending";
  try {
    await operation();
    element.textContent = `${label}：正常`;
    element.dataset.state = "success";
  } catch (error) {
    // Only controlled status codes are shown; URLs, keys and response bodies stay out of the UI.
    const code =
      error instanceof Error && /^HTTP \d{3}$/.test(error.message)
        ? `（${error.message}）`
        : "（请求失败或响应无效）";
    element.textContent = `${label}：失败${code}`;
    element.dataset.state = "failure";
  }
}

async function run() {
  retry.disabled = true;
  checkedAt.textContent = "";
  try {
    const config = await configuration();
    await Promise.all([
      check(gateway, "后端连接", async () => {
        const data = await readJson(new URL("/healthz", config.apiUrl));
        if (
          !data ||
          typeof data !== "object" ||
          !("status" in data) ||
          data.status !== "ready"
        )
          throw new Error("响应无效");
      }),
      check(supabase, "Supabase 连接", async () => {
        const data = await readJson(
          new URL("/auth/v1/settings", config.apiUrl),
          { apikey: config.publishableKey },
        );
        if (
          !data ||
          typeof data !== "object" ||
          !("external" in data) ||
          !data.external ||
          typeof data.external !== "object"
        )
          throw new Error("响应无效");
      }),
    ]);
  } catch {
    for (const element of [gateway, supabase]) {
      element.textContent = "运行配置：加载失败";
      element.dataset.state = "failure";
    }
  } finally {
    checkedAt.textContent = `检测时间（UTC）：${new Date().toISOString()}`;
    retry.disabled = false;
  }
}

retry.addEventListener("click", () => void run());
void run();
