import type { Command, CommandRegistry } from "./command.ts";
import type { Scope } from "./scope.ts";

export type ParsedCommand =
  | { kind: "ok"; name: string; args: Record<string, string> }
  | { kind: "error"; message: string };

export function parseCommand(input: string, registry: CommandRegistry, scope?: Scope): ParsedCommand {
  // NFKC folds full-width forms (e.g. ／ U+FF0F → / U+002F, ｈｅｌｐ → help) so
  // Chinese IME mistypes still route to commands. Only applied here on the command
  // path; never on prompt bodies that go to the LLM.
  const trimmed = input.trim().normalize("NFKC");
  if (!trimmed.startsWith("/")) {
    return { kind: "error", message: "命令必须以 / 开头" };
  }

  const tokenized = tokenize(trimmed.slice(1));
  if (tokenized.kind === "error") return tokenized;
  const tokens = tokenized.tokens;
  if (tokens.length === 0) {
    return { kind: "error", message: "空命令" };
  }

  const [name, ...rest] = tokens;
  const cmd = registry[name.toLowerCase()];
  if (!cmd) {
    return { kind: "error", message: `未知命令：${name}` };
  }

  return consumeParams(cmd, rest, scope);
}

// Shell-like tokenizer: splits on whitespace, but `"..."` and `'...'` keep their
// contents (including spaces) as a single token. Quotes only toggle quoting mode;
// `a"b c"d` becomes `ab cd`, matching POSIX shell intuition. Unclosed quotes
// surface as an error so callers see the typo instead of a silently truncated arg.
type TokenizeResult = { kind: "ok"; tokens: string[] } | { kind: "error"; message: string };

function tokenize(input: string): TokenizeResult {
  const tokens: string[] = [];
  let current = "";
  let inToken = false;
  let quote: '"' | "'" | null = null;

  for (const ch of input) {
    if (quote !== null) {
      if (ch === quote) {
        quote = null;
      } else {
        current += ch;
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      inToken = true;
      continue;
    }
    if (/\s/u.test(ch)) {
      if (inToken) {
        tokens.push(current);
        current = "";
        inToken = false;
      }
      continue;
    }
    current += ch;
    inToken = true;
  }

  if (quote !== null) {
    return { kind: "error", message: `引号未闭合：${quote}` };
  }
  if (inToken) tokens.push(current);
  return { kind: "ok", tokens };
}

function consumeParams(cmd: Command, tokens: string[], scope?: Scope): ParsedCommand {
  const args: Record<string, string> = {};

  const params = scope
    ? cmd.params.filter((p) => !p.scope || p.scope.includes(scope))
    : cmd.params;

  // Build a set of known named params for this command
  const namedParams = new Set(
    params.filter((p) => p.kind === "named").map((p) => p.name)
  );

  // First pass: extract --key value pairs, collect remaining positional tokens
  const positionalTokens: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (token.startsWith("--")) {
      const key = token.slice(2);
      if (namedParams.has(key)) {
        const value = tokens[i + 1];
        if (value === undefined) {
          return { kind: "error", message: `--${key} 需要一个值` };
        }
        // Reject `--flag` as the value of another `--flag` when it matches a
        // known named param — silently swallowing it would route arguments to
        // the wrong slot and the user's real intent would be lost.
        if (value.startsWith("--") && namedParams.has(value.slice(2))) {
          return { kind: "error", message: `--${key} 需要一个值（不能直接接另一个 --${value.slice(2)}）` };
        }
        args[key] = value;
        i++; // skip the value token
        continue;
      }
    }
    positionalTokens.push(token);
  }

  // Second pass: consume positional and rest params from remaining tokens
  let cursor = 0;
  for (const param of params) {
    if (param.kind === "named") continue; // already handled

    if (param.kind === "rest") {
      const restTokens = positionalTokens.slice(cursor);
      if (restTokens.length === 0) {
        if (param.required) {
          return { kind: "error", message: `缺少参数：${param.name}` };
        }
        continue;
      }
      args[param.name] = restTokens.join(" ");
      cursor = positionalTokens.length;
      continue;
    }

    const token = positionalTokens[cursor];
    if (token === undefined) {
      if (param.required) {
        return { kind: "error", message: `缺少参数：${param.name}` };
      }
      continue;
    }

    if (param.type === "enum" && param.enum && !param.enum.includes(token)) {
      return {
        kind: "error",
        message: `参数 ${param.name} 必须是以下之一：${param.enum.join("|")}`,
      };
    }

    args[param.name] = token;
    cursor += 1;
  }

  if (cursor < positionalTokens.length) {
    return { kind: "error", message: `多余的参数：${positionalTokens.slice(cursor).join(" ")}` };
  }

  return { kind: "ok", name: cmd.name, args };
}
