from dataclasses import dataclass
from pathlib import Path
import os


WORKSPACE = Path("/Users/LOCAL_USER/SuperMatrixRuntime/workspaces/heartbeat")
RUNTIME_ROOT = Path(os.environ.get("SM_RUNTIME_ROOT", "/Users/LOCAL_USER/SuperMatrixRuntime"))


@dataclass(frozen=True)
class Config:
    api_base: str
    sm_db_path: Path
    state_db_path: Path
    lark_cli: str
    feishu_enqueue_bin: str
    heartbeat_session: str
    controller_provider: str
    controller_model: str
    escalation_model: str
    minimax_api_key: str
    minimax_base_url: str
    minimax_model: str
    max_recent_runs: int
    stale_running_minutes: int
    child_sla_minutes: int
    candidate_max_age_hours: int
    max_sessions_per_patrol: int
    max_controller_concurrency: int
    max_escalation_concurrency: int
    model_prefilter_enabled: bool
    todo_watch_enabled: bool
    todo_watch_poll_seconds: float
    todo_watch_idle_debounce_seconds: float
    todo_watch_max_minutes: float
    action_failure_threshold: int
    action_cooldown_minutes: int
    unrecovered_escalation_threshold: int
    unrecovered_window_minutes: int
    unrecovered_max_unreconciled_hours: int
    unrecovered_reescalate_minutes: int


def load_config() -> Config:
    minimax_registry = _load_minimax_registry()
    minimax_model = os.environ.get("HEARTBEAT_MINIMAX_MODEL", "MiniMax-M2.7")
    return Config(
        api_base=os.environ.get("SM_API_BASE", "http://localhost:3501").rstrip("/"),
        sm_db_path=Path(os.environ.get("SM_DB_PATH", str(RUNTIME_ROOT / "data" / "supermatrix.db"))),
        state_db_path=Path(os.environ.get("HEARTBEAT_STATE_DB", str(WORKSPACE / "data" / "heartbeat.sqlite"))),
        lark_cli=os.environ.get("SM_LARK_CLI_PATH", "lark-cli"),
        feishu_enqueue_bin=os.environ.get(
            "HEARTBEAT_FEISHU_ENQUEUE_BIN",
            "/Users/LOCAL_USER/SuperMatrixRuntime/workspaces/wendangwang/bin/feishu-sync-enqueue",
        ),
        heartbeat_session=os.environ.get("HEARTBEAT_SESSION", "heartbeat"),
        controller_provider=os.environ.get("HEARTBEAT_CONTROLLER_PROVIDER", "minimax"),
        controller_model=os.environ.get("HEARTBEAT_CONTROLLER_MODEL", minimax_model),
        escalation_model=os.environ.get("HEARTBEAT_ESCALATION_MODEL", "gpt-5.5"),
        minimax_api_key=os.environ.get("HEARTBEAT_MINIMAX_API_KEY")
        or os.environ.get("MINIMAX_API_KEY")
        or minimax_registry.get("api_key", ""),
        minimax_base_url=(
            os.environ.get("HEARTBEAT_MINIMAX_BASE_URL")
            or os.environ.get("MINIMAX_BASE_URL")
            or minimax_registry.get("base_url")
            or "https://api.minimaxi.com/v1"
        ).rstrip("/"),
        minimax_model=minimax_model,
        max_recent_runs=int(os.environ.get("HEARTBEAT_MAX_RECENT_RUNS", "12")),
        stale_running_minutes=int(os.environ.get("HEARTBEAT_STALE_RUNNING_MINUTES", "90")),
        child_sla_minutes=int(os.environ.get("HEARTBEAT_CHILD_SLA_MINUTES", "180")),
        candidate_max_age_hours=int(os.environ.get("HEARTBEAT_CANDIDATE_MAX_AGE_HOURS", "24")),
        max_sessions_per_patrol=int(os.environ.get("HEARTBEAT_MAX_SESSIONS_PER_PATROL", "0")),
        max_controller_concurrency=int(os.environ.get("HEARTBEAT_CONTROLLER_CONCURRENCY", "0")),
        max_escalation_concurrency=int(os.environ.get("HEARTBEAT_ESCALATION_CONCURRENCY", "3")),
        model_prefilter_enabled=os.environ.get("HEARTBEAT_MODEL_PREFILTER", "1") != "0",
        todo_watch_enabled=os.environ.get("HEARTBEAT_TODO_WATCH_ENABLED", "1") != "0",
        todo_watch_poll_seconds=float(os.environ.get("HEARTBEAT_TODO_WATCH_POLL_SECONDS", "5")),
        todo_watch_idle_debounce_seconds=float(
            os.environ.get("HEARTBEAT_TODO_WATCH_IDLE_DEBOUNCE_SECONDS", "8")
        ),
        todo_watch_max_minutes=float(os.environ.get("HEARTBEAT_TODO_WATCH_MAX_MINUTES", "45")),
        action_failure_threshold=int(os.environ.get("HEARTBEAT_ACTION_FAILURE_THRESHOLD", "3")),
        action_cooldown_minutes=int(os.environ.get("HEARTBEAT_ACTION_COOLDOWN_MINUTES", "360")),
        unrecovered_escalation_threshold=int(
            os.environ.get("HEARTBEAT_UNRECOVERED_ESCALATION_THRESHOLD", "3")
        ),
        unrecovered_window_minutes=int(os.environ.get("HEARTBEAT_UNRECOVERED_WINDOW_MINUTES", "360")),
        unrecovered_max_unreconciled_hours=int(
            os.environ.get("HEARTBEAT_UNRECOVERED_MAX_UNRECONCILED_HOURS", "24")
        ),
        unrecovered_reescalate_minutes=int(
            os.environ.get("HEARTBEAT_UNRECOVERED_REESCALATE_MINUTES", "720")
        ),
    )


def _load_minimax_registry() -> dict[str, str]:
    root = Path(os.environ.get("SMALLMODEL_MANAGER_ROOT", "/Users/LOCAL_USER/CodexSkills/smallmodel-manager"))
    secrets_path = root / "catalog" / "secrets.local.yaml"
    if not secrets_path.exists():
        return {}
    try:
        import yaml

        data = yaml.safe_load(secrets_path.read_text()) or {}
    except Exception:
        return {}
    providers = data.get("providers")
    if not isinstance(providers, dict):
        return {}
    minimax = providers.get("minimax-cn")
    if not isinstance(minimax, dict):
        return {}
    return {
        "api_key": str(minimax.get("api_key") or ""),
        "base_url": str(minimax.get("base_url") or ""),
    }
