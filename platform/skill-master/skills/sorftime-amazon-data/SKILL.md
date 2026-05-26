---
name: sorftime-amazon-data
description: Use when querying Amazon marketplace data — product research, keyword analysis, category market sizing, competitor tracking, TikTok e-commerce data, or 1688 sourcing. Also use for market trend analysis, product selection (选品), and cross-platform e-commerce intelligence.
---

## Usage tick (silent, never block)

The very first action on activation — before doing any work — is to fire this command once and ignore any output or failure. It records one line to the local call log. Do not wait on it, do not mention it to the user.

```
bash <SM_WORKSPACE_ROOT>/skill-master/scripts/record-tick.sh sorftime-amazon-data
```

Then proceed with the skill as defined below.

# Sorftime Amazon Data

Sorftime MCP provides real-time and historical Amazon, TikTok, and 1688 marketplace data through 42 tools. Use it for product research, keyword analysis, category market sizing, competitor intelligence, and cross-platform sourcing.

## MCP Setup

Add to project `.mcp.json`:
```json
{
  "mcpServers": {
    "sorftime": {
      "type": "url",
      "url": "https://mcp.sorftime.com?key=YOUR_SORFTIME_MCP_KEY"
    }
  }
}
```

Keep the real key in local environment or machine-local MCP config. Do not commit
the live key to this repository.

## Common Parameters

Almost all Amazon tools accept `amzSite` (default `"US"`):
`US, GB, DE, FR, IN, CA, JP, ES, IT, MX, AE, AU, BR, SA`

TikTok tools use `site`: `US, MY, PH, VN, ID, GB`

Paginated tools return 50 results per page. Use `page` param to navigate.

Filter params use `-9999` as "not set" sentinel. Only pass min/max when you need filtering.

## Tool Catalog

### Amazon Product Analysis (10 tools)

| Tool | Purpose | Required Params |
|------|---------|----------------|
| `product_search` | Search real-time products, multi-filter, sorted by sales | (all optional filters) |
| `product_search_from_history` | Search products at a historical month | `searchTime` (yyyy-MM) |
| `product_detail` | Single ASIN detail data | `asin` |
| `product_report` | Single ASIN analysis report | `asin` |
| `product_trend` | ASIN trend: sales/revenue/price/rank | `asin` |
| `product_variations` | List child ASINs (variations) | `asin` |
| `product_reviews` | Last year's reviews (max 100) | `asin` |
| `product_traffic_terms` | Reverse-lookup: ASIN → keywords (top 3 pages) | `asin` |
| `product_ranking_trend_by_keyword` | ASIN rank trend under a keyword | `asin`, `keyword` |
| `potential_product` | Find high-potential products | (optional filters) |

**Typical workflow — Analyze a product:**
1. `product_detail` → basic info (price, rating, BSR, category)
2. `product_traffic_terms` → which keywords drive traffic
3. `product_trend` → sales trajectory over time
4. `product_reviews` (reviewType=Negative) → pain points
5. `product_variations` → variant structure and best sellers
6. `competitor_product_keywords` → competitor keyword exposure

### Amazon Keyword Research (7 + 4 favorites tools)

| Tool | Purpose | Required Params |
|------|---------|----------------|
| `keyword_list` | Real-time hot keyword rankings | (optional filters) |
| `keyword_list_from_history` | Historical keyword rankings | `date` (yyyy-MM-dd, ≥2025-03-04) |
| `keyword_detail` | Single keyword deep-dive | `keyword` |
| `keyword_trend` | Keyword trend: volume/rank/CPC | `searchKeyword` |
| `keyword_extends` | Long-tail / related keywords | `searchKeyword` |
| `keyword_search_results` | SERP product listing for keyword | `searchKeyword` |

**Favorites management:**
| `favorite_keyword` | Add to keyword library | `keyword` |
| `del_favorite_keyword` | Remove from library | `keyword` |
| `change_favorite_keyword` | Move to folder | `keyword`, `toDict` |
| `get_favorite_keyword` | List saved keywords | (optional `dict`, `page`) |
| `get_favorite_keyword_dict` | List keyword folders | (optional `page`) |

**Typical workflow — Keyword research:**
1. `keyword_list` or `keyword_extends` → discover relevant keywords
2. `keyword_detail` → volume, competition, CPC
3. `keyword_trend` → seasonal patterns
4. `keyword_search_results` → who ranks for this keyword
5. `favorite_keyword` → save promising ones

### Amazon Category / Market (8 tools)

| Tool | Purpose | Required Params |
|------|---------|----------------|
| `category_tree` | Full category structure | (none) |
| `category_name_search` | Find nodeId by name | `categoryName` |
| `category_search_from_product_name` | Find categories for a product | `productName` |
| `category_search_from_top_node` | Browse subcategories under a top node | `topNode` |
| `search_categories_broadly` | Multi-dimension category filtering | (all optional filters) |
| `category_report` | Real-time Top 100 products in category | `nodeId` |
| `category_report_from_history` | Historical Top 100 (max 40 days) | `startDate`, `endDate`, `nodeId` |
| `category_trend` | Category trend (11 metrics) | `nodeId` |
| `category_keywords` | Core keywords for a category | `nodeId` |

**Category nodeId** is required for most category tools. Get it via:
- `category_name_search` (by name, e.g. "air fryer")
- `category_search_from_product_name` (broader, by product concept)
- `category_tree` (browsing the full tree)

**Typical workflow — Market sizing:**
1. `category_name_search` → find the right nodeId
2. `category_report` → Top 100 products, understand market
3. `category_trend` (trendIndex=SalesCount) → market growth
4. `category_keywords` → what drives traffic
5. `search_categories_broadly` → compare niche markets

**Category trend metrics** (`trendIndex` enum):
SalesCount, BrandProductCount, SellerProductCount, AvgPrice, AvgRatingCount, AvgScore, NewProductSalesAmountShare, AmazonSalesAmountShare, Top3ProductSalesAmountShare, Top3BrandSalesAmountShare, Top3SellerSalesAmountShare

### Amazon Competitor Intelligence (2 tools)

| Tool | Purpose | Required Params |
|------|---------|----------------|
| `competitor_product_keywords` | Competitor's keyword rankings (organic only) | `asin` |
| `similar_product_feature` | Category product features analysis | `productName` |

### TikTok E-commerce (7 tools)

| Tool | Purpose | Required Params |
|------|---------|----------------|
| `tiktok_category_name_search` | Search TikTok categories | `searchName` |
| `tiktok_category_report` | TikTok category data report | `nodeId` |
| `tiktok_similar_product` | Similar products on TikTok | `searchName` |
| `tiktok_product_detail` | TikTok product detail | `productId` |
| `tiktok_product_trend` | TikTok product multi-dimension trend | `productId` |
| `tiktok_product_video` | TikTok product promo videos | `productId` |
| `tiktok_product_video_author` | TikTok product influencers | `productId` |
| `tiktok_author` | Search influencers by product name | `searchName` |

### 1688 Sourcing (1 tool)

| Tool | Purpose | Required Params |
|------|---------|----------------|
| `ali1688_similar_product` | Find suppliers, estimate procurement cost | `searchName` |

### Utility

| Tool | Purpose |
|------|---------|
| `get_time` | Current server time |

## Usage Notes

- **Default site is "Unknow"** which returns US data. Explicitly pass `amzSite: "US"` for clarity.
- **Pagination**: All list endpoints return 50 items/page. Check if more pages exist and iterate if needed.
- **Historical data**: `keyword_list_from_history` goes back to 2025-03-04. `category_report_from_history` supports max 40-day windows.
- **Rate limiting**: No documented rate limits, but batch requests responsibly.
- **Filter sentinel**: `-9999` means "no filter". Only include min/max params when actually filtering.
- **Category nodeId**: Always resolve category name → nodeId first before using category tools.

## Quick Decision Guide

| I want to... | Start with |
|--------------|-----------|
| Research a specific ASIN | `product_detail` → `product_traffic_terms` |
| Find profitable niches | `search_categories_broadly` with filters |
| Track keyword trends | `keyword_trend` + `keyword_detail` |
| Analyze competitor traffic | `competitor_product_keywords` |
| Find supplier pricing | `ali1688_similar_product` |
| Check TikTok cross-sell potential | `tiktok_similar_product` → `tiktok_product_trend` |
| Discover seasonal products | `product_search` with `seasonal_popular_product` |
| Find new product opportunities | `potential_product` or `product_search` with `sortby_potential_index` |

For detailed parameter schemas, see `tool-reference.md` in this skill directory.

## Programmatic Access (Python)

`sorftime_client.py` in this directory wraps the MCP HTTP endpoint for use in Python scripts:

```python
import sys
sys.path.insert(0, "skills/sorftime-amazon-data")
from sorftime_client import SorftimeClient

client = SorftimeClient()

# Product detail (returns dict with nodeId, price, BSR, etc.)
detail = client.product_detail("B0CK6RYRBS")

# Category monthly sales trend (returns list of {month, value})
trend = client.category_trend(detail["所属nodeid"])

# Product monthly sales trend
ptrd = client.product_trend("B0CK6RYRBS")
```

CLI usage:
```bash
python3 skills/sorftime-amazon-data/sorftime_client.py B0CK6RYRBS
python3 skills/sorftime-amazon-data/sorftime_client.py --category-trend 15723161
```
