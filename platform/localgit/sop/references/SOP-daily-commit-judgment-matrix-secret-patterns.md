# R1 DENY-SECRET 模式清单（唯一权威）

> 消费方：`SOP-daily-commit-judgment-matrix` Step 2 R1。两个清单都是「命中即 DENY」，大小写不敏感。
> 增删条目只改本文件；代码实现必须从与本清单同步的常量表读取，测试须断言两者一致。

## 1. 文件名 / 路径模式（对 basename 与相对路径分别匹配）

```text
.env
.env.*
*.pem
*.key
*.p12
*.pfx
*.keystore
*.jks
id_rsa*
id_ed25519*
*.ppk
.npmrc
.netrc
.pgpass
*credential*
*token*（排除 *tokenizer* / *token_count*）
*secret*
*cookie*
*.kdbx
service-account*.json
.aws/**
.ssh/**
```

## 2. 内容正则（对 Step 1 的内容样本执行；单条命中即 DENY）

```text
-----BEGIN( RSA| EC| OPENSSH| PGP)? PRIVATE KEY-----
AKIA[0-9A-Z]{16}
ghp_[A-Za-z0-9]{36}
github_pat_[A-Za-z0-9_]{22,}
xox[abpr]-[A-Za-z0-9-]{10,}
sk-ant-[A-Za-z0-9-]{20,}
sk-[A-Za-z0-9]{32,}
AIza[0-9A-Za-z_-]{35}
(?i)authorization:\s*bearer\s+ey[A-Za-z0-9_-]{20,}
(?i)(api[_-]?key|access[_-]?token|client[_-]?secret)\s*[:=]\s*['"][A-Za-z0-9_-]{16,}['"]
(?i)password\s*[:=]\s*['"][^'"]{8,}['"]
```

## 3. 误报处置

命中但人工确认非敏感（如测试 fixture 的假 token）：不放宽本清单，改为在该仓 manifest（`registry/repo-policies/<repo>.json`）加一条 `{"pattern":"<精确文件路径>","action":"commit","note":"fixture 假凭证，人工确认 <日期>"}` 的精确路径豁免；豁免只允许精确路径，不允许 glob。
