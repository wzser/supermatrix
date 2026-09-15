"""Optional attachment operation boundary for the public queue subset."""


def bitable_attachment_dedupe(*_args, **_kwargs):
    raise ValueError(
        "attachment dedupe is outside the portable public queue subset; use the owner-managed attachment contract"
    )


def validate_attachment_dedupe_key(*_args, **_kwargs):
    raise ValueError("attachment dedupe is outside the portable public queue subset")


def validate_attachment_dedupe_payload(*_args, **_kwargs):
    raise ValueError("attachment dedupe is outside the portable public queue subset")
