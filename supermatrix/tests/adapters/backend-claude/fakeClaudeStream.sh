#!/usr/bin/env bash
echo '{"session_id":"bks-stream-1"}'
sleep 0.3
echo '{"type":"message_delta","delta":"hel"}'
sleep 0.3
echo '{"type":"message_delta","delta":"lo"}'
sleep 0.3
echo '{"type":"result","result":"hello"}'
