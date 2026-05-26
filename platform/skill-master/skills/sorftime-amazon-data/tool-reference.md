# Sorftime Tool Reference — Full Parameter Schemas

## Common Enums

**amzSite** (Amazon): `Unknow, US, GB, DE, FR, IN, CA, JP, ES, IT, MX, AE, AU, BR, SA`
**site** (TikTok): `Unknow, US, MY, PH, VN, ID, GB`
**delivery_type**: `Both, FBM, FBA`
**reviewType**: `Both, Positive, Negative`

## Amazon Product Tools

### product_search
搜索亚马逊实时产品数据，默认按月销量倒序

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| searchName | string | no | 产品名称搜索 |
| brand | string | no | 品牌筛选 |
| seller_name | string | no | 卖家筛选 |
| property_name | string | no | 标题/属性包含指定关键词 |
| price_min / price_max | number | no | 价格范围 |
| month_sales_volume_min / max | integer | no | 月销量范围 |
| ratings_min / max | number | no | 评分范围 |
| ratings_count_min / max | integer | no | 评论数范围 |
| subcategory_sales_volume_rank_min / max | integer | no | 细分类目销量排名 |
| delivery_type | enum | no | 发货方式 |
| variation_count_min / max | integer | no | 子体数量 |
| seasonal_popular_product | enum | no | 热销旺季月份 |
| sortby_potential_index | boolean | no | 按潜力指数(隐赚指数)排序 |
| page | integer | no | 页码 (default=1) |
| amzSite | enum | no | 站点 |

### product_search_from_history
搜索历史产品数据

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| searchTime | string | **yes** | 时间段 yyyy-MM |
| searchName | string | no | 产品名称 |
| price_min / max | number | no | 价格范围 |
| month_sales_volume_min / max | integer | no | 月销量 |
| ratings_min / max | number | no | 评分 |
| ratings_count_min / max | integer | no | 评论数 |
| delivery_type | enum | no | 发货方式 |
| amzSite | enum | no | 站点 (注意: 不含 AU, BR) |

### product_detail
产品详情

| Param | Type | Required |
|-------|------|----------|
| asin | string | **yes** |
| amzSite | enum | no |

### product_report
产品分析报告

| Param | Type | Required |
|-------|------|----------|
| asin | string | **yes** |
| amzSite | enum | no |

### product_trend
产品趋势

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| asin | string | **yes** | |
| productTrendType | enum | no | SalesVolume/SalesAmount/Price/Rank (default=SalesVolume) |
| amzSite | enum | no | |

### product_variations
子体明细

| Param | Type | Required |
|-------|------|----------|
| asin | string | **yes** |
| amzSite | enum | no |

### product_reviews
产品评论 (近一年, 最多100条)

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| asin | string | **yes** | |
| reviewType | enum | no | Both/Positive(4-5星)/Negative(1-3星) |
| amzSite | enum | no | |

### product_traffic_terms
产品反查关键词 (前3页曝光)

| Param | Type | Required |
|-------|------|----------|
| asin | string | **yes** |
| page | integer | no |
| amzSite | enum | no |

### product_ranking_trend_by_keyword
产品在关键词下的排名趋势

| Param | Type | Required |
|-------|------|----------|
| asin | string | **yes** |
| keyword | string | **yes** |
| page | integer | no |
| amzSite | enum | no |

### potential_product
搜索潜力产品

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| searchName | string | no | 产品名称 |
| price_min / max | number | no | 价格 |
| month_sales_volume_min / max | integer | no | 月销量 |
| delivery_type | enum | no | FBA/FBM |
| page | integer | no | |
| amzSite | enum | no | 仅支持 US, GB, DE, FR |

## Amazon Keyword Tools

### keyword_list
实时热搜关键词榜 (按周搜索量排序)

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| rank_min / max | integer | no | 周搜索量排名 |
| search_volume_min / max | integer | no | 月搜索量 |
| page | integer | no | |
| amzSite | enum | no | |

### keyword_list_from_history
历史热搜关键词 (≥2025-03-04)

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| date | string | **yes** | 日期 yyyy-MM-dd |
| rank_min / max | integer | no | |
| search_volume_min / max | integer | no | |
| page | integer | no | |
| amzSite | enum | no | |

### keyword_detail
关键词详情

| Param | Type | Required |
|-------|------|----------|
| keyword | string | **yes** |
| amzSite | enum | no |

### keyword_trend
关键词趋势 (搜索量/排名/CPC)

| Param | Type | Required |
|-------|------|----------|
| searchKeyword | string | **yes** |
| amzSite | enum | no |

### keyword_extends
延伸词/长尾词

| Param | Type | Required |
|-------|------|----------|
| searchKeyword | string | **yes** |
| page | integer | no |
| amzSite | enum | no |

### keyword_search_results
关键词搜索结果产品清单

| Param | Type | Required |
|-------|------|----------|
| searchKeyword | string | **yes** |
| page | integer | no |
| amzSite | enum | no |

### Keyword Favorites (4 tools)

**favorite_keyword** — 收藏: `keyword` (required), `dict`, `amzSite`
**del_favorite_keyword** — 删除: `keyword` (required), `dict`, `amzSite`
**change_favorite_keyword** — 移动: `keyword` + `toDict` (required), `fromDict`, `amzSite`
**get_favorite_keyword** — 查询: `dict` (传 "all" 查全部), `page`, `amzSite`
**get_favorite_keyword_dict** — 收藏夹列表: `page`, `amzSite`

## Amazon Category Tools

### category_tree
类目结构树

| Param | Type | Required |
|-------|------|----------|
| amzSite | enum | no |

### category_name_search
按名称搜索类目 → 获取 nodeId

| Param | Type | Required |
|-------|------|----------|
| categoryName | string | **yes** |
| amzSite | enum | no |

### category_search_from_product_name
按产品名搜索类目 (含多维筛选)

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| productName | string | **yes** | 品类名称 |
| month_sales_volume_min / max | integer | no | 月销量 |
| ratings_min / max | number | no | 评分 |
| ratings_count_min / max | integer | no | 评论数 |
| price_min / max | number | no | 均价(当地货币) |
| seasonal_popular_product | enum | no | 旺季月份 |
| top3Product_sales_share_min / max | number | no | 销量垄断系数 (0-1) |
| amazonOwned_sales_share_min / max | number | no | 自营垄断系数 (0-1) |
| top100_top400_sales_share_min / max | number | no | 长尾系数 (低=长尾) |
| newproduct_sales_share_min / max | number | no | 新品销量占比 (0-1) |
| page | integer | no | |
| amzSite | enum | no | |

### category_search_from_top_node
从大品类浏览细分类目 (参数同上, `topNode` 替代 `productName`)

### search_categories_broadly
无约束广泛搜索 (参数同 category_search_from_product_name, 但无 required params)

### category_report
实时类目 Top100

| Param | Type | Required |
|-------|------|----------|
| nodeId | string | **yes** |
| amzSite | enum | no |

### category_report_from_history
历史类目 Top100 (最长40天)

| Param | Type | Required |
|-------|------|----------|
| startDate | string | **yes** |
| endDate | string | **yes** |
| nodeId | string | **yes** |
| amzSite | enum | no |

### category_trend
类目趋势

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| nodeId | string | **yes** | |
| trendIndex | enum | no | 11种指标, default=SalesCount |
| amzSite | enum | no | |

### category_keywords
类目核心关键词

| Param | Type | Required |
|-------|------|----------|
| nodeId | string | **yes** |
| page | integer | no |
| amzSite | enum | no |

## Amazon Competitor Tools

### competitor_product_keywords
竞品关键词曝光 (仅自然排名)

| Param | Type | Required |
|-------|------|----------|
| asin | string | **yes** |
| page | integer | no |
| amzSite | enum | no |

### similar_product_feature
类目产品特点分析

| Param | Type | Required |
|-------|------|----------|
| productName | string | **yes** |
| amzSite | enum | no |

## TikTok Tools

### tiktok_category_name_search
搜索 TikTok 类目

| Param | Type | Required |
|-------|------|----------|
| searchName | string | **yes** |
| site | enum | no |

### tiktok_category_report
| nodeId (required), site |

### tiktok_similar_product
| searchName (required), page, site |

### tiktok_product_detail
| productId (required), site |

### tiktok_product_trend
多维趋势: 销量/价格/星级/评论数/视频数/达人数
| productId (required), site |

### tiktok_product_video
| productId (required), page, site |

### tiktok_product_video_author
| productId (required), site |

### tiktok_author
按产品名搜索带货达人
| searchName (required), page, site |

## 1688 Tool

### ali1688_similar_product
找货源, 分析采购成本
| searchName (required), page |

## Utility

### get_time
获取当前服务器时间 (无参数)
