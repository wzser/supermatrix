# SOP Index

| SOP 文件 | 状态 | 更新日期 | Owner | 何时用 | 上下游 |
|---|---|---|---|---|---|
| [SOP-add-shared-skill-active-20260804-35bn0g.md](SOP-add-shared-skill-active-20260804-35bn0g.md) | active | 2026-08-04 | skill-master | 新增或迁移单个 shared / claude-only / codex-only canonical skill；不覆盖外部托管升级 | `skills/<name>/SKILL.md` -> YAML validator -> `skills/INDEX.md` -> `scripts/sync-skills.sh` -> Feishu registry |
| [SOP-skill-hosting-upgrade-active-20260711-skup26.md](SOP-skill-hosting-upgrade-active-20260711-skup26.md) | active | 2026-07-11 | skill-master | 盘点所有 skill、纳入外部 GitHub 自动升级、回滚、同步飞书 Skill Registry、登记表格王托管 | `skills/INDEX.md` + `config/skill-upgrade-sources.json` -> weekly upgrade/rollback -> Feishu registry -> wendangwang |
