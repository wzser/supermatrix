"""Optional attachment operation boundary for the public queue subset."""

ATTACHMENT_REPLACE_OP = "bitable_attachment_replace_if_current"


class AttachmentRetryableMediaFailure(ValueError):
    pass


def attachment_retry_advice(**_kwargs):
    return {"status": "unsupported", "reason": "owner-managed attachment contract required"}


def _unsupported(*_args, **_kwargs):
    raise ValueError(
        "attachment operations are outside the portable public queue subset; use the owner-managed attachment contract"
    )


bitable_attachment_replace_if_current = _unsupported
check_controlled_attachment_replace = _unsupported
validate_attachment_replace_queue_entry = _unsupported


def make_attachment_replace_dedupe_key(*_args, **_kwargs):
    return _unsupported(*_args, **_kwargs)


def validate_attachment_replace_payload(*_args, **_kwargs):
    return _unsupported(*_args, **_kwargs)
