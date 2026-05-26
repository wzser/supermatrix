export type ExecutorResult = {
  success: boolean;
  output: string;
  error: string | null;
};

export type ShellConfig = {
  command: string;
  cwd: string;
  timeout: number;
};

export type HttpConfig = {
  url: string;
  method: string;
  headers?: Record<string, string>;
  body?: unknown;
  timeout: number;
};
