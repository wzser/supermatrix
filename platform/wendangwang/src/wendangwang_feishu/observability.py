"""读回属性可观测性三态语义（observable / unobservable / ambiguous）。

一处定义、各读回校验点复用（P2，docs/plans/2026-08-04-schema-time-friction-plan.md §4）：

- observable:   读接口返回了该属性且形状正常 → 正常比对，真不匹配必须拒绝。
- unobservable: 读接口根本没返回该属性（键缺失）→ 退化为不校验，receipt 标
  ``unobservable:<属性名>``。禁止把「我读不到」判成业务失败。
- ambiguous:    读到了但形状异常（如 view-list 把 visible_fields 回成 "16 fields"
  计数字符串）→ 同样退化为不校验，单独标 ``ambiguous:<属性名>``，供巡检区分
  reader 漂移与真缺失。

边界：本模块只放松「读回校验」。写决策（no_change 判定不许因不可观测判「无需写」）
和写目标属性的 fail-closed（写什么必须读回什么，如新建表描述、视图列序落地确认）
不经过本模块放松——调用方对不可观测的写目标仍按既有语义 fail-closed。
"""

from __future__ import annotations

from dataclasses import dataclass
from decimal import Decimal, InvalidOperation, ROUND_DOWN, ROUND_HALF_EVEN
from typing import Any, Callable, Iterable

STATE_OBSERVABLE = "observable"
STATE_UNOBSERVABLE = "unobservable"
STATE_AMBIGUOUS = "ambiguous"


@dataclass(frozen=True)
class AttributeObservation:
    """One attribute as seen through a read-back surface."""

    attribute: str
    state: str
    value: Any = None
    detail: str = ""

    @property
    def observable(self) -> bool:
        return self.state == STATE_OBSERVABLE

    @property
    def receipt_tag(self) -> str | None:
        if self.observable:
            return None
        return f"{self.state}:{self.attribute}"


@dataclass(frozen=True)
class AttributeVerdict:
    """Verification outcome for one observed attribute.

    ``passed`` is False only when the attribute is observable and truly
    mismatched; unobservable/ambiguous degrade to pass and carry the tag.
    """

    observation: AttributeObservation
    passed: bool

    @property
    def mismatched(self) -> bool:
        return self.observation.observable and not self.passed

    @property
    def receipt_tag(self) -> str | None:
        return self.observation.receipt_tag


def observe_key(
    container: Any,
    key: str,
    *,
    attribute: str | None = None,
    shape: type | tuple[type, ...] | None = None,
) -> AttributeObservation:
    """Classify one mapping key through the tri-state semantics.

    键缺失 → unobservable（reader 结构性没给）；容器不是 mapping 或值形状不符
    ``shape`` → ambiguous（读到了但形状异常）；否则 observable。键存在值为空
    （None/""）是 observable——「真没落地」必须留在严格比对里。
    """
    name = attribute or key
    if not isinstance(container, dict):
        return AttributeObservation(
            name, STATE_AMBIGUOUS,
            detail=f"container is {type(container).__name__}, not a mapping",
        )
    if key not in container:
        return AttributeObservation(
            name, STATE_UNOBSERVABLE, detail=f"reader did not return key {key!r}"
        )
    value = container[key]
    if shape is not None and value is not None and not isinstance(value, shape):
        return AttributeObservation(
            name, STATE_AMBIGUOUS, value=value,
            detail=f"unexpected shape {type(value).__name__}",
        )
    return AttributeObservation(name, STATE_OBSERVABLE, value=value)


def verify_attribute(
    observation: AttributeObservation, matches: Callable[[Any], bool]
) -> AttributeVerdict:
    """Degrade non-observable attributes; strictly judge observable ones."""
    if not observation.observable:
        return AttributeVerdict(observation, passed=True)
    return AttributeVerdict(observation, passed=bool(matches(observation.value)))


def receipt_tags(*sources: Iterable[Any]) -> list[str]:
    """Collect sorted unique receipt tags from observations/verdicts/strings."""
    tags: set[str] = set()
    for source in sources:
        for item in source or []:
            tag = item if isinstance(item, str) else item.receipt_tag
            if tag:
                tags.add(tag)
    return sorted(tags)


# 飞书 number 字段按 15 位有效数字序列化浮点值（本地 951.3333333333334 读回成
# 951.333333333333）：第 16 位起在远端不可观测，是同一套三态语义的数值特例——
# 不可观测的尾数退化为不比对，15 位以内的真实差异仍判不等。
FEISHU_NUMBER_SIGNIFICANT_DIGITS = 15


def feishu_number_equal(remote_value: Any, write_value: Any) -> bool:
    """Compare two number cells at Feishu's observable precision."""
    if isinstance(remote_value, bool) or isinstance(write_value, bool):
        return False
    try:
        remote_number = Decimal(str(remote_value).strip())
        write_number = Decimal(str(write_value).strip())
    except (InvalidOperation, ValueError):
        return False
    if not (remote_number.is_finite() and write_number.is_finite()):
        return False
    if remote_number.normalize() == write_number.normalize():
        return True
    # The reader returns Feishu's wire representation, which has been observed
    # to retain the first 15 significant digits (truncate) as well as ordinary
    # decimal rounding.  Unary ``Decimal`` rounding alone therefore rejects a
    # valid round trip at a carry boundary such as
    # ``8.459999999999999 -> 8.45999999999999``.  Compare the observed remote
    # value with the two possible 15-significant-digit serializations of the
    # submitted value; do not reduce *both* sides, or a real 15th-digit change
    # could be hidden.
    exponent = write_number.adjusted() - FEISHU_NUMBER_SIGNIFICANT_DIGITS + 1
    quantum = Decimal(1).scaleb(exponent)
    observable_forms = {
        write_number.quantize(quantum, rounding=ROUND_DOWN).normalize(),
        write_number.quantize(quantum, rounding=ROUND_HALF_EVEN).normalize(),
    }
    return remote_number.normalize() in observable_forms
