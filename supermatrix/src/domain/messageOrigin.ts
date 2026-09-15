export const MESSAGE_ORIGINS = [
  "lark_user",
  "lark_user_synthetic",
  "framework_synthetic",
] as const;

export type MessageOrigin = (typeof MESSAGE_ORIGINS)[number];

export function isLarkUserOrigin(origin: MessageOrigin | undefined): boolean {
  return origin === "lark_user" || origin === "lark_user_synthetic";
}

export function isHumanLarkUserOrigin(origin: MessageOrigin | undefined): boolean {
  return origin === "lark_user";
}

export function allowsLegacyCommandRouting(origin: MessageOrigin | undefined): boolean {
  return origin === undefined || origin === "lark_user";
}
