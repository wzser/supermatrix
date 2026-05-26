import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import {
  createCodexStreamState,
  parseCodexStream,
} from "../../../src/adapters/backend-codex/streamParser.ts";

const SAMPLES = join(dirname(fileURLToPath(import.meta.url)), "samples");

async function load(name: string): Promise<string[]> {
  const text = await readFile(join(SAMPLES, name), "utf8");
  return text.split(/\r?\n/u).filter((l) => l.trim().length > 0);
}

function parseAll(lines: string[]) {
  const state = createCodexStreamState();
  return [
    ...parseCodexStream(lines, state),
    ...parseCodexStream([], state, { flush: true }),
  ];
}

describe("parseCodexStream", () => {
  test("init.jsonl yields started + completed", async () => {
    const events = parseAll(await load("init.jsonl"));
    expect(events[0]?.kind).toBe("started");
    expect(events.some((e) => e.kind === "completed")).toBe(true);
  });

  test("normal.jsonl ends with a non-empty completed finalMessage", async () => {
    const events = parseAll(await load("normal.jsonl"));
    const completed = events.find((e) => e.kind === "completed");
    expect(completed).toBeTruthy();
    if (completed && completed.kind === "completed") {
      expect(completed.finalMessage.trim().length).toBeGreaterThan(0);
    }
  });

  test("long_task.jsonl emits commentary as thinking before completion", async () => {
    const events = parseAll(await load("long_task.jsonl"));
    const interim = events.filter((e) => e.kind === "thinking");
    expect(interim.length).toBeGreaterThanOrEqual(3);
    expect(events.at(-1)?.kind).toBe("completed");
  });

  test("commentary agent_message becomes process trace, not final text", () => {
    const events = parseAll([
      '{"type":"event_msg","payload":{"type":"agent_message","phase":"commentary","message":"两个想法 A/B"}}',
      '{"type":"item.completed","item":{"type":"agent_message","text":"等你确认"}}',
    ]);
    expect(events).toContainEqual({ kind: "thinking", text: "两个想法 A/B" });
    const assistantMsgs = events.filter((e) => e.kind === "assistant_message");
    expect(assistantMsgs).toHaveLength(1);
    if (assistantMsgs[0].kind === "assistant_message") {
      expect(assistantMsgs[0].text).toBe("等你确认");
      expect(assistantMsgs[0].final).toBe(true);
    }
  });

  test("tool preamble agent_message stays out of finalMessage", () => {
    const events = parseCodexStream([
      '{"type":"thread.started","thread_id":"bks-tool"}',
      '{"type":"turn.started"}',
      '{"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"Running `pwd` in the shell, then I’ll return the exact final string you requested."}}',
      '{"type":"item.started","item":{"id":"item_1","type":"command_execution","command":"/bin/zsh -lc pwd","aggregated_output":"","exit_code":null,"status":"in_progress"}}',
      '{"type":"item.completed","item":{"id":"item_1","type":"command_execution","command":"/bin/zsh -lc pwd","aggregated_output":"/private/tmp\\n","exit_code":0,"status":"completed"}}',
      '{"type":"item.completed","item":{"id":"item_2","type":"agent_message","text":"DONE"}}',
      '{"type":"turn.completed","usage":{"input_tokens":37706,"cached_input_tokens":29440,"output_tokens":163}}',
    ]);

    expect(events).toContainEqual({
      kind: "thinking",
      text: "Running `pwd` in the shell, then I’ll return the exact final string you requested.",
    });
    expect(events).toContainEqual({ kind: "tool_call", name: "/bin/zsh -lc pwd", args: {} });
    expect(events).toContainEqual({
      kind: "tool_result",
      name: "/bin/zsh -lc pwd",
      result: { output: "/private/tmp\n", exitCode: 0 },
    });
    const assistantMsgs = events.filter((e) => e.kind === "assistant_message");
    expect(assistantMsgs).toEqual([{ kind: "assistant_message", text: "DONE", final: true }]);
    const completed = events.find((e) => e.kind === "completed");
    expect(completed).toEqual({ kind: "completed", finalMessage: "DONE" });
  });

  test("function_call observability parses response_item function calls and outputs", () => {
    const events = parseCodexStream([
      JSON.stringify({
        type: "response_item",
        payload: {
          type: "function_call",
          name: "exec_command",
          arguments: JSON.stringify({
            cmd: 'sqlite3 /tmp/amz.db "PRAGMA table_info(dwd__business_report_asin_shop_d);"',
            workdir: "<SM_WORKSPACE_ROOT>/product-tracker",
            yield_time_ms: 1000,
          }),
          call_id: "call_Q7GqN59jKqSnekWbFXPiz2KO",
        },
      }),
      JSON.stringify({
        type: "response_item",
        payload: {
          type: "function_call_output",
          call_id: "call_Q7GqN59jKqSnekWbFXPiz2KO",
          output: "Chunk ID: abc\nProcess exited with code 0\nOutput:\n0|dt|TEXT",
        },
      }),
    ]);

    expect(events).toContainEqual({
      kind: "tool_call",
      callId: "call_Q7GqN59jKqSnekWbFXPiz2KO",
      name: "exec_command",
      command: 'sqlite3 /tmp/amz.db "PRAGMA table_info(dwd__business_report_asin_shop_d);"',
      args: {
        cmd: 'sqlite3 /tmp/amz.db "PRAGMA table_info(dwd__business_report_asin_shop_d);"',
        workdir: "<SM_WORKSPACE_ROOT>/product-tracker",
        yield_time_ms: 1000,
      },
    });
    expect(events).toContainEqual({
      kind: "tool_result",
      callId: "call_Q7GqN59jKqSnekWbFXPiz2KO",
      name: "exec_command",
      command: 'sqlite3 /tmp/amz.db "PRAGMA table_info(dwd__business_report_asin_shop_d);"',
      result: {
        output: "Chunk ID: abc\nProcess exited with code 0\nOutput:\n0|dt|TEXT",
      },
    });
  });

  test("error.jsonl yields an error event", async () => {
    const events = parseCodexStream(await load("error.jsonl"));
    expect(events.some((e) => e.kind === "error")).toBe(true);
  });

  test("task_complete with last_agent_message=null emits empty-completion error", () => {
    // Repro of codex-cli 0.128.0 + effort=xhigh silent-fail (5/7 16:39 incident):
    // turn ends with task_complete carrying null last_agent_message; without
    // this guard the run would land as completed + final_message="" and the
    // user would see no reply.
    const events = parseAll([
      JSON.stringify({
        type: "event_msg",
        payload: {
          type: "task_complete",
          turn_id: "t1",
          last_agent_message: null,
          completed_at: 1778143196,
          duration_ms: 44360,
        },
      }),
    ]);
    const err = events.find((e) => e.kind === "error");
    expect(err).toEqual({
      kind: "error",
      message: "codex returned empty completion (last_agent_message=null)",
      recoverable: false,
    });
  });

  test("task_complete with non-null last_agent_message does NOT emit error", () => {
    const events = parseAll([
      JSON.stringify({
        type: "event_msg",
        payload: {
          type: "task_complete",
          turn_id: "t1",
          last_agent_message: "ok",
          completed_at: 1778143196,
          duration_ms: 1000,
        },
      }),
    ]);
    expect(events.some((e) => e.kind === "error")).toBe(false);
  });

  test("task_complete after a non-final agent_message does NOT emit error", () => {
    // pendingAgentMessage was set; turn.completed will flush it as final.
    // This guards against false-positive when codex emits task_complete
    // with last=null but a real agent_message is queued from item.completed.
    const events = parseAll([
      JSON.stringify({
        type: "item.completed",
        item: { type: "agent_message", text: "thoughtful answer" },
      }),
      JSON.stringify({
        type: "event_msg",
        payload: {
          type: "task_complete",
          turn_id: "t1",
          last_agent_message: null,
        },
      }),
    ]);
    expect(events.some((e) => e.kind === "error")).toBe(false);
  });

  test("malformed lines are skipped", () => {
    const events = parseCodexStream(["not json", "{}"]);
    expect(events).toEqual([]);
  });

  test("uses fallback model when usage records omit model", () => {
    const state = createCodexStreamState("gpt-5.4");
    parseCodexStream(
      ['{"type":"turn.completed","usage":{"input_tokens":17937,"cached_input_tokens":6528,"output_tokens":39}}'],
      state
    );
    const flushed = parseCodexStream([], state, { flush: true });
    const usage = flushed.find((e) => e.kind === "usage");
    expect(usage).toBeTruthy();
    if (usage?.kind === "usage") {
      expect(usage.model).toBe("gpt-5.4");
      expect(usage.rawUsage).toMatchObject({ model: "gpt-5.4" });
    }
  });

  test("emits per-turn usage events as each turn commits (running-phase updates)", () => {
    // Two distinct turns stream in: a turn.completed for turn#1 (coarse),
    // then a token_count for turn#2 (rich, different numbers). The parser
    // should commit turn#1 as soon as turn#2 forces it out of pending, and
    // then commit turn#2 at flush. Two separate usage events lets the
    // replier card title update live ("X.Xk/1000k") instead of waiting
    // for stream end.
    const lines = [
      '{"type":"thread.started","thread_id":"bks-usage-1"}',
      '{"type":"turn.completed","usage":{"input_tokens":16655,"cached_input_tokens":11904,"output_tokens":35}}',
      '{"type":"event_msg","payload":{"type":"token_count","info":null,"rate_limits":{"limit_id":"codex"}}}',
      '{"type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":17173,"cached_input_tokens":7552,"output_tokens":758,"reasoning_output_tokens":516,"total_tokens":17931},"last_token_usage":{"input_tokens":17173,"cached_input_tokens":7552,"output_tokens":758,"reasoning_output_tokens":516,"total_tokens":17931},"model_context_window":258400},"rate_limits":{"limit_id":"codex","primary":{"used_percent":12.0,"window_minutes":300,"resets_at":1776535218},"secondary":{"used_percent":8.0,"window_minutes":10080,"resets_at":1776963617},"credits":null,"plan_type":"pro"}}}',
    ];
    const state = createCodexStreamState();
    const chunkEvents = parseCodexStream(lines, state);
    const chunkUsage = chunkEvents.filter((e) => e.kind === "usage");
    expect(chunkUsage).toHaveLength(1);
    if (chunkUsage[0].kind === "usage") {
      // turn#1 committed when the non-matching rich arrived
      expect(chunkUsage[0].inputTokens).toBe(16655);
      expect(chunkUsage[0].outputTokens).toBe(35);
      expect(chunkUsage[0].cacheReadTokens).toBe(11904);
      expect(chunkUsage[0].reasoningTokens).toBe(0);
    }

    const flushed = parseCodexStream([], state, { flush: true });
    const flushUsage = flushed.filter((e) => e.kind === "usage");
    expect(flushUsage).toHaveLength(1);
    if (flushUsage[0].kind === "usage") {
      // turn#2 committed at flush; reasoning subtracted from raw output
      expect(flushUsage[0].inputTokens).toBe(17173);
      expect(flushUsage[0].outputTokens).toBe(242);
      expect(flushUsage[0].cacheReadTokens).toBe(7552);
      expect(flushUsage[0].reasoningTokens).toBe(516);
      expect(flushUsage[0].contextWindowTokens).toBe(258400);
    }

    // Summed by the replier's accumulateUsage → same totals the old
    // aggregated flush would have produced.
    const all = [...chunkUsage, ...flushUsage];
    const sum = all.reduce(
      (acc, ev) => {
        if (ev.kind !== "usage") return acc;
        return {
          input: acc.input + ev.inputTokens,
          output: acc.output + ev.outputTokens,
          cacheRead: acc.cacheRead + ev.cacheReadTokens,
          reasoning: acc.reasoning + ev.reasoningTokens,
        };
      },
      { input: 0, output: 0, cacheRead: 0, reasoning: 0 }
    );
    expect(sum).toEqual({ input: 33828, output: 277, cacheRead: 19456, reasoning: 516 });
  });

  test("flush prefers token_count over matching turn.completed for the same turn", () => {
    const lines = [
      '{"type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":17173,"cached_input_tokens":7552,"output_tokens":758,"reasoning_output_tokens":516,"total_tokens":17931},"last_token_usage":{"input_tokens":17173,"cached_input_tokens":7552,"output_tokens":758,"reasoning_output_tokens":516,"total_tokens":17931},"model_context_window":258400},"rate_limits":{"limit_id":"codex"}}}',
      '{"type":"turn.completed","usage":{"input_tokens":17173,"cached_input_tokens":7552,"output_tokens":758}}',
    ];
    const state = createCodexStreamState();
    parseCodexStream(lines, state);
    const flushed = parseCodexStream([], state, { flush: true });
    const usages = flushed.filter((e) => e.kind === "usage");
    expect(usages).toHaveLength(1);
    const usage = usages[0];
    if (usage.kind === "usage") {
      expect(usage.inputTokens).toBe(17173);
      expect(usage.outputTokens).toBe(242);
      expect(usage.cacheReadTokens).toBe(7552);
      expect(usage.reasoningTokens).toBe(516);
      expect(usage.contextWindowTokens).toBe(258400);
      expect(usage.rawUsage).toEqual({
        input_tokens: 17173,
        cached_input_tokens: 7552,
        output_tokens: 758,
        reasoning_output_tokens: 516,
      });
    }
  });
});
