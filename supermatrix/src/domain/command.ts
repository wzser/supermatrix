import type { Scope } from "./scope.ts";

export type CommandParam = {
  name: string;
  type: "string" | "enum";
  required: boolean;
  kind: "positional" | "named" | "rest";
  enum?: string[];
  scope?: Scope[];
};

export type Command = {
  name: string;
  description: string;
  notes?: string;
  scope: Scope[];
  params: CommandParam[];
};

export type CommandRegistry = Record<string, Command>;
