import qrcode from "qrcode-terminal";

export type PersonalAgentRegistration = {
  appId: string;
  appSecret: string;
  tenant: string;
  operatorOpenId?: string;
};

type RegistrationResult = {
  client_id?: unknown;
  client_secret?: unknown;
  user_info?: {
    tenant_brand?: unknown;
    open_id?: unknown;
  };
};

export function requiredLarkScopes(): string[] {
  return [
    "im:message",
    "im:message:readonly",
    "im:chat:read",
    "im:chat.members:read",
    "im:chat.members:write_only",
    "im:chat:create_by_user",
  ];
}

export function normalizeRegistrationResult(result: RegistrationResult): PersonalAgentRegistration {
  if (typeof result.client_id !== "string" || result.client_id.length === 0) {
    throw new Error("PersonalAgent registration returned no client_id");
  }
  if (typeof result.client_secret !== "string" || result.client_secret.length === 0) {
    throw new Error("PersonalAgent registration returned no client_secret");
  }
  const tenant = typeof result.user_info?.tenant_brand === "string"
    ? result.user_info.tenant_brand
    : "feishu";
  const operatorOpenId = typeof result.user_info?.open_id === "string"
    ? result.user_info.open_id
    : undefined;

  return {
    appId: result.client_id,
    appSecret: result.client_secret,
    tenant,
    ...(operatorOpenId ? { operatorOpenId } : {}),
  };
}

export async function runPersonalAgentWizard(): Promise<PersonalAgentRegistration> {
  const { registerApp } = await import("@larksuiteoapi/node-sdk");

  console.log("\n未检测到完整飞书/Lark 配置，进入 PersonalAgent 扫码初始化。\n");
  const result = await registerApp({
    source: "supermatrix",
    onQRCodeReady: (info: { url: string; expireIn: number }) => {
      console.log("请用飞书/Lark App 扫描二维码创建或选择 PersonalAgent 应用：\n");
      qrcode.generate(info.url, { small: true });
      const mins = Math.max(1, Math.round(info.expireIn / 60));
      console.log(`\n二维码有效期：约 ${mins} 分钟`);
      console.log(`也可以直接在浏览器打开：${info.url}\n`);
    },
    onStatusChange: (info: { status: string }) => {
      if (info.status === "domain_switched") {
        console.log("识别到国际版租户，已切换到 larksuite.com 域名。");
      } else if (info.status === "slow_down") {
        console.log("轮询速度过快，已自动降速。");
      }
    },
  });

  const normalized = normalizeRegistrationResult(result as RegistrationResult);
  console.log("\n✓ PersonalAgent 应用创建/绑定成功");
  console.log(`  App ID: ${normalized.appId}`);
  console.log(`  Tenant: ${normalized.tenant}`);
  if (normalized.operatorOpenId) {
    console.log(`  Operator: ${normalized.operatorOpenId}`);
  }
  console.log("");
  return normalized;
}
