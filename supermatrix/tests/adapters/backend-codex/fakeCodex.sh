#!/usr/bin/env bash
scenario="${1:-happy}"
case "$scenario" in
  happy)
    echo '{"type":"thread.started","thread_id":"bks-fake-1"}'
    echo '{"type":"item.completed","item":{"type":"agent_message","text":"ok"}}'
    ;;
  usage)
    echo '{"type":"thread.started","thread_id":"bks-fake-usage"}'
    echo '{"type":"event_msg","payload":{"type":"agent_message","phase":"commentary","message":"counting tokens"}}'
    echo '{"type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":16006,"cached_input_tokens":12000,"output_tokens":770,"reasoning_output_tokens":463,"total_tokens":16776},"last_token_usage":{"input_tokens":16006,"cached_input_tokens":12000,"output_tokens":770,"reasoning_output_tokens":463,"total_tokens":16776},"model_context_window":258400},"rate_limits":{"limit_id":"codex"}}}'
    echo '{"type":"item.completed","item":{"type":"agent_message","text":"done"}}'
    echo '{"type":"turn.completed","usage":{"input_tokens":16006,"cached_input_tokens":12000,"output_tokens":770}}'
    ;;
  slow)
    echo '{"type":"thread.started","thread_id":"bks-fake-2"}'
    sleep 60
    ;;
  ignore-sigterm)
    trap '' TERM
    echo '{"type":"thread.started","thread_id":"bks-fake-3"}'
    sleep 60
    ;;
  env)
    echo '{"type":"thread.started","thread_id":"bks-fake-env"}'
    echo "{\"type\":\"item.completed\",\"item\":{\"type\":\"agent_message\",\"text\":\"SM_SESSION_NAME=${SM_SESSION_NAME}\"}}"
    ;;
  attest)
    echo '{"type":"thread.started","thread_id":"bks-fake-attest"}'
    echo "{\"type\":\"item.completed\",\"item\":{\"type\":\"agent_message\",\"text\":\"SM_CALLER_ATTESTATION=${SM_CALLER_ATTESTATION}\"}}"
    ;;
  env-proxy)
    echo '{"type":"thread.started","thread_id":"bks-fake-env-proxy"}'
    echo "{\"type\":\"item.completed\",\"item\":{\"type\":\"agent_message\",\"text\":\"HTTPS_PROXY=${HTTPS_PROXY};HTTP_PROXY=${HTTP_PROXY};ALL_PROXY=${ALL_PROXY}\"}}"
    ;;
  noise-with-api-error)
    # Repro of 5/7 21:22 incident: codex CLI 0.128.0 prints the stdin-prompt
    # noise to stderr at startup, then emits an API 400 error to stdout JSON,
    # then exits non-zero. Old behavior: stderr noise clobbered the API
    # error in error_message. New behavior: noise filtered, API error wins.
    echo "Reading additional input from stdin..." >&2
    echo '{"type":"thread.started","thread_id":"bks-fake-err"}'
    echo '{"type":"error","message":"gpt-5.3 not supported with ChatGPT account"}'
    exit 1
    ;;
  noise-only-no-stdout-error)
    # Stderr has ONLY the known noise line, exit non-zero, stdout has no
    # error event. We should still push `exit ${code}` so the failure isn't
    # silent — only stripping noise, not silencing real failures.
    echo "Reading additional input from stdin..." >&2
    echo '{"type":"thread.started","thread_id":"bks-fake-noise"}'
    exit 2
    ;;
  real-stderr-and-exit)
    # Real stderr content (not the known noise). Must NOT be filtered out.
    echo "Reading additional input from stdin..." >&2
    echo "permission denied: /Users/whatever" >&2
    exit 1
    ;;
  capacity-with-model-manager)
    # Live mr_f9c9e220 repro: codex emits a provider "at capacity" error to
    # stdout JSON, THEN logs the timestamped codex_models_manager child-exit
    # timeout to stderr, then exits non-zero. The stderr line is secondary
    # noise and must not mask the real capacity root cause.
    echo '{"type":"error","message":"Selected model is at capacity. Please try a different model."}'
    echo "2026-07-15T04:12:33.123456Z ERROR codex_models_manager::manager: failed to refresh available models: timeout waiting for child process to exit" >&2
    exit 1
    ;;
  model-manager-only)
    # The model-manager child-exit timeout appears ALONE with no stdout error.
    # It is filtered as noise, but the non-zero exit must still surface so the
    # run does not falsely report success.
    echo "2026-07-15T04:12:33.123456Z ERROR codex_models_manager::manager: failed to refresh available models: timeout waiting for child process to exit" >&2
    exit 3
    ;;
  model-manager-plus-real-stderr)
    # The model-manager noise mixed with a genuine stderr line: only the noise
    # line is stripped; the real content is preserved.
    echo "2026-07-15T04:12:33.123456Z ERROR codex_models_manager::manager: failed to refresh available models: timeout waiting for child process to exit" >&2
    echo "permission denied: /Users/whatever" >&2
    exit 1
    ;;
esac
