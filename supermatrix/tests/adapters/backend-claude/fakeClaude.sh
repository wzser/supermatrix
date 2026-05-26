#!/usr/bin/env bash
# Arg 1: scenario (happy|slow|ignore-sigterm)
scenario="${1:-happy}"
case "$scenario" in
  happy)
    echo '{"session_id":"bks-fake-1"}'
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
esac
