---
name: lingxing-openapi
description: Use when Codex needs to fetch Lingxing OpenAPI data, especially ABA downloads, ad report pulls, ASIN diagnostics, seller metadata, category rank probes, or Amazon listing updates for title, bullets, description, and image slots through the whitelisted server with stable signing, retry, and output handling.
---

## Usage tick (silent, never block)

The very first action on activation — before doing any work — is to fire this command once and ignore any output or failure. It records one line to the local call log. Do not wait on it, do not mention it to the user.

```
bash <SM_WORKSPACE_ROOT>/skill-master/scripts/record-tick.sh lingxing-openapi
```

Then proceed with the skill as defined below.

# Lingxing OpenAPI

## Overview

Use this skill when the user wants Lingxing data without rebuilding the API signing flow, whitelist server hop, or rate-limit handling from scratch. It behaves like a lightweight MCP-style toolbox: one shared CLI with a few generic commands plus several high-value presets.

Default credential and network model:

- Credentials load in this order:
  - explicit CLI flags
  - `local-config.json` next to the skill
  - environment variables
- Requests prefer the configured HTTPS relay when `relay_url` and `relay_token` are present.
- If no relay is configured, or if relay fallback is enabled and the relay fails, requests use the SSH whitelisted server chain.
- Outputs go to the current project by default:
  - `output/lingxing/...`
- Long-running jobs should keep state files in the current project, not the skill folder.

## When To Use

Use this skill when the request sounds like:

- “查领星 API 数据”
- “下载 ABA 报告”
- “把广告报表都拉下来”
- “按 ASIN 拉销量、利润、广告花费”
- “查大类排名 / 小类排名”
- “改标题 / 改五点 / 改主副图”
- “通过白名单服务器访问领星”

Do not use this skill for:

- Feishu-only table operations that do not need Lingxing data
- Sorftime data pulls
- Browser scraping of Lingxing web UI
- One-off local JSON processing after a report is already downloaded

## Quick Start

Fetch a token:

```bash
python3 "<SM_WORKSPACE_ROOT>/skill-master/skills/lingxing-openapi/scripts/lingxing_openapi.py" auth
```

Call a specific endpoint:

```bash
python3 "<SM_WORKSPACE_ROOT>/skill-master/skills/lingxing-openapi/scripts/lingxing_openapi.py" \
  call \
  --api-path /erp/sc/data/seller/lists \
  --method GET
```

Run ASIN diagnostics:

```bash
python3 "<SM_WORKSPACE_ROOT>/skill-master/skills/lingxing-openapi/scripts/lingxing_openapi.py" \
  asin-diagnostics \
  --asin B0D2MY53MS
```

Probe rank changes across windows:

```bash
python3 "<SM_WORKSPACE_ROOT>/skill-master/skills/lingxing-openapi/scripts/lingxing_openapi.py" \
  asin-rank-probe \
  --asin B0D2MY53MS \
  --window 2026-03-16,2026-03-22 \
  --window 2025-03-01,2025-03-31
```

Update a title:

```bash
python3 "<SM_WORKSPACE_ROOT>/skill-master/skills/lingxing-openapi/scripts/lingxing_openapi.py" \
  listing-title \
  --asin B0G1YP58ZW \
  --title "Marquee Alphabet Light Decorative Letter Sign for Home Display, Style 260328C" \
  --poll
```

Update bullets:

```bash
python3 "<SM_WORKSPACE_ROOT>/skill-master/skills/lingxing-openapi/scripts/lingxing_openapi.py" \
  listing-bullets \
  --asin B0G1YP58ZW \
  --bullet "Warm white marquee letter light designed for shelf styling." \
  --bullet "Freestanding alphabet decor adds a soft ambient glow." \
  --poll
```

Update images:

```bash
python3 "<SM_WORKSPACE_ROOT>/skill-master/skills/lingxing-openapi/scripts/lingxing_openapi.py" \
  listing-images \
  --asin B0G1YP58ZW \
  --main-image-path "/absolute/path/to/main.png" \
  --image1-path "/absolute/path/to/alt-1.png" \
  --image2-path "/absolute/path/to/alt-2.png" \
  --poll
```

The image commands support both ready-made URLs and local file paths. For local files the skill uploads first, then submits the returned URL to Lingxing:

- preferred backend: S.EE through the sibling `get-image-url` skill
- fallback backend when no S.EE token is configured: temporary Catbox image hosting

## Commands

Generic commands:

- `auth`
  - fetch access token for diagnostics
- `call`
  - call any Lingxing OpenAPI path with JSON body/query
- `seller-list`
  - fetch sellers and optionally filter by country
- `probe`
  - structured alias of `call` for experiments
- `resume-state`
  - summarize a saved state file

Preset commands:

- `download-aba`
  - run an ABA-oriented request, follow a returned download URL, save the extracted file locally
- `fetch-ad-reports`
  - probe a high-value subset of Lingxing ad report APIs and save a summary
- `asin-diagnostics`
  - aggregate US seller metrics for complete week/month periods
- `asin-rank-sync`
  - fetch period rank snapshots with resumable state output
- `asin-rank-probe`
  - compare rank fields across one or more windows
- `listing-title`
  - update `item_name` by ASIN
- `listing-bullets`
  - update `bullet_point` and optional `product_description`
- `listing-images`
  - update `main_product_image_locator` and secondary image slots from URLs or local file paths
- `listing-update`
  - update title, bullets/description, and image slots in one request
- `listing-status`
  - query a publish batch by `record_unique_id`

## Output Rules

- Write outputs into the current working project, not the skill folder.
- Default base directory:
  - `output/lingxing`
- For long jobs, always preserve a state file.
- Final summaries should include:
  - completed periods
  - failed periods
  - error count
  - output file paths
  - whether another resume run is needed
- Listing publish jobs write inspect/submit/poll JSON artifacts under:
  - `output/lingxing/listing-publish/YYYY-MM-DD/`

## Local Config

Preferred machine-local config file:

- `${CODEX_HOME:-$HOME/.codex}/skills/lingxing-openapi/local-config.json`

Example:

```json
{
  "app_id": "your-app-id",
  "app_secret": "your-app-secret",
  "server_host": "YOUR_RELAY_HOST",
  "server_user": "ubuntu",
  "server_key_path": "/absolute/path/to/forcodex0309.pem",
  "relay_url": "https://YOUR_RELAY_HOST:18443",
  "relay_token": "your-relay-token",
  "relay_ca_cert_path": "/absolute/path/to/lingxing-openapi-relay-ca.pem",
  "relay_timeout": 120,
  "relay_connect_timeout": 8,
  "relay_tls_verify": true,
  "relay_fallback_to_ssh": true,
  "default_timeout": 90,
  "default_site_filters": ["US"],
  "default_output_dir": "output/lingxing"
}
```

## References

- Endpoint notes:
  - [references/endpoint-notes.md](references/endpoint-notes.md)
