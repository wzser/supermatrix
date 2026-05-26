# Lingxing Endpoint Notes

- `statisticsOpenASIN`
  - Path: `/bd/profit/statistics/open/asin/list`
  - Works with `startDate`, `endDate`, `searchField`, `searchValue`, `sids`
  - Good for profit, ad cost, ad sales, units, sales
  - Time range should be chunked into 7-day windows for reliability

- `AsinListNew`
  - Path: `/bd/productPerformance/openApi/asinList`
  - Requires `snake_case` body keys
  - Use `sid`, not `sids`
  - Must include `summary_field`
  - Returns `cate_rank`, `rank_category`, `small_cate_rank`

- Amazon listing search / publish
  - Listing lookup path: `/erp/sc/data/mws/listing`
  - Product inspect path: `/listing/publish/openapi/amazon/product/search`
  - Publish path: `/listing/publish/openapi/amazon/product/publish`
  - Publish result path: `/listing/publish/openapi/amazon/product/list`
  - Publish/search requests must use compact sorted JSON bytes:
    - `json.dumps(body, ensure_ascii=False, separators=(",", ":"), sort_keys=True)`
    - send as `data=...`, not `json=...`
  - Useful attributes confirmed in live tests:
    - `item_name`
    - `bullet_point`
    - `product_description`
    - `main_product_image_locator`
    - `other_product_image_locator_1`
    - `other_product_image_locator_2`
  - Image slots support precise replacement
  - Image slot deletion via `[]`, `""`, or `null` was not accepted in live tests
  - For local images, the skill now uploads first:
    - preferred uploader: S.EE via `$get-image-url`
    - fallback uploader when no S.EE token is configured: Catbox temporary hosting

- Seller list
  - Path: `/erp/sc/data/seller/lists`
  - Useful for filtering US seller ids before aggregation

- HTTPS relay mode
  - Server script: `scripts/lingxing_relay_server.py`
  - Public endpoint: `POST /v1/operation`
  - Auth: `Authorization: Bearer <relay_token>`
  - Server stores `LINGXING_APP_ID` and `LINGXING_APP_SECRET`; the client sends only the operation payload.
  - Client prefers relay when `relay_url` and `relay_token` are configured.
  - Use `relay_ca_cert_path` for a self-signed relay certificate instead of disabling TLS verification.
  - SSH fallback remains available with `relay_fallback_to_ssh=true`.

- Rate limiting
  - `AsinListNew` is much stricter than profit endpoints
  - `103 请勿频繁请求` should be treated as a retriable throttle
  - Prefer period-level state files for long-running rank sync jobs
