#!/usr/bin/env bash

localwatch_ps_snapshot() {
  /bin/ps -ax -o pid=,ppid=,command= 2>/dev/null
}

localwatch_command_matches_script() {
  local command_line="$1" expected_script="$2"
  [[ "$command_line" == "bash $expected_script" \
    || "$command_line" == "/bin/bash $expected_script" ]]
}

localwatch_same_script_pids() {
  local expected_script="$1" exclude_pid="${2:-}" line pid ppid command_line
  local ps_snapshot
  if ! ps_snapshot="$(localwatch_ps_snapshot)"; then
    echo "[localwatch] same-name process scan failed" >&2
    return 2
  fi

  # Fork subshells inherit this script's command line in ps — including the
  # command substitution that evaluates this very call. Without descendant
  # exclusion the scan matches its own subshells and every absolute-path
  # bootstrap refuses itself (2026-08-28 crash loop). Exclude the caller and
  # all of its descendants; a genuine second instance is never our child.
  local exclusions changed candidate parent
  exclusions=" ${exclude_pid:-} "
  changed=1
  while (( changed )); do
    changed=0
    while IFS= read -r line; do
      line="${line#"${line%%[![:space:]]*}"}"
      [[ -n "$line" ]] || continue
      candidate="${line%%[[:space:]]*}"
      [[ "$candidate" =~ ^[0-9]+$ ]] || continue
      case "$exclusions" in *" $candidate "*) continue ;; esac
      parent="${line#"$candidate"}"
      parent="${parent#"${parent%%[![:space:]]*}"}"
      parent="${parent%%[[:space:]]*}"
      case "$exclusions" in
        *" $parent "*)
          exclusions+="$candidate "
          changed=1
          ;;
      esac
    done <<< "$ps_snapshot"
  done

  while IFS= read -r line; do
    line="${line#"${line%%[![:space:]]*}"}"
    [[ -n "$line" ]] || continue
    pid="${line%%[[:space:]]*}"
    [[ "$pid" =~ ^[0-9]+$ ]] || continue
    case "$exclusions" in *" $pid "*) continue ;; esac
    ppid="${line#"$pid"}"
    ppid="${ppid#"${ppid%%[![:space:]]*}"}"
    command_line="${ppid#"${ppid%%[[:space:]]*}"}"
    ppid="${ppid%%[[:space:]]*}"
    command_line="${command_line#"${command_line%%[![:space:]]*}"}"
    if localwatch_command_matches_script "$command_line" "$expected_script"; then
      printf '%s\n' "$pid"
    fi
  done <<< "$ps_snapshot"
}
