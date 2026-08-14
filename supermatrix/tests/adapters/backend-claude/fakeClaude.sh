#!/usr/bin/env bash
# Arg 1: scenario (happy|slow|ignore-sigterm)
scenario="${1:-happy}"
case "$scenario" in
  happy)
    echo '{"session_id":"bks-fake-1"}'
    echo '{"type":"result","result":"ok"}'
    ;;
  invalid-signature-then-happy)
    if [[ " $* " == *" --resume "* ]]; then
      echo '{"session_id":"bks-poisoned"}'
      echo 'API Error: 400 messages.1.content.0: Invalid `signature` in `thinking` block' >&2
      exit 1
    fi
    echo '{"session_id":"bks-fresh"}'
    echo '{"type":"result","result":"ok"}'
    ;;
  cannot-modify-then-happy)
    if [[ " $* " == *" --resume "* ]]; then
      echo '{"session_id":"bks-poisoned"}'
      echo 'API Error: 400 messages.35.content.5: thinking or redacted_thinking blocks in the latest assistant message cannot be modified. These blocks must remain as they were in the original response.' >&2
      exit 1
    fi
    echo '{"session_id":"bks-fresh"}'
    echo '{"type":"result","result":"ok"}'
    ;;
  slow)
    echo '{"session_id":"bks-fake-2"}'
    sleep 60
    ;;
  ignore-sigterm)
    trap '' TERM
    echo '{"session_id":"bks-fake-3"}'
    sleep 60
    ;;
  env)
    echo '{"session_id":"bks-fake-env"}'
    echo "{\"type\":\"result\",\"result\":\"SM_SESSION_NAME=${SM_SESSION_NAME}\"}"
    ;;
  attest)
    echo '{"session_id":"bks-fake-attest"}'
    echo "{\"type\":\"result\",\"result\":\"SM_CALLER_ATTESTATION=${SM_CALLER_ATTESTATION}\"}"
    ;;
esac
