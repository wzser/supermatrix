"""
Sorftime MCP HTTP client.
Wraps the Sorftime MCP endpoint (JSON-RPC over SSE) into Python functions.
"""

import json
import os
import re
import urllib.request

ENDPOINT_TEMPLATE = "https://mcp.sorftime.com?key={key}"


class SorftimeClient:
    def __init__(self, key=None):
        key = key or os.environ.get("SORFTIME_MCP_KEY", "")
        if not key:
            raise RuntimeError("Missing Sorftime MCP key. Set SORFTIME_MCP_KEY or pass key=...")
        self.endpoint = ENDPOINT_TEMPLATE.format(key=key)
        self._req_id = 0

    # ── low-level ────────────────────────────────────────────

    def call_tool(self, tool_name: str, arguments: dict) -> str:
        """Send JSON-RPC 2.0 tools/call, return raw text from response."""
        self._req_id += 1
        payload = json.dumps({
            "jsonrpc": "2.0",
            "id": self._req_id,
            "method": "tools/call",
            "params": {"name": tool_name, "arguments": arguments},
        }).encode()

        req = urllib.request.Request(
            self.endpoint,
            data=payload,
            headers={
                "Content-Type": "application/json",
                "Accept": "application/json, text/event-stream",
            },
        )
        with urllib.request.urlopen(req, timeout=30) as resp:
            body = resp.read().decode()

        # SSE format: "event: message\ndata: {json}\n"
        for line in body.split("\n"):
            if line.startswith("data:"):
                msg = json.loads(line[5:].strip())
                content = msg.get("result", {}).get("content", [])
                if content:
                    return content[0].get("text", "")
        return ""

    # ── parsers ──────────────────────────────────────────────

    @staticmethod
    def _parse_trend(text: str) -> list:
        """Parse '2024年04月=25965,...' into [{"month": "2024-04", "value": 25965}, ...]."""
        results = []
        for m in re.finditer(r"(\d{4})\u5e74(\d{2})\u6708=(\d+)", text):
            results.append({"month": f"{m.group(1)}-{m.group(2)}", "value": int(m.group(3))})
        return results

    @staticmethod
    def _parse_kv(text: str) -> dict:
        """Parse 'key：value\\r\\n' lines into dict. Best-effort."""
        out = {}
        for line in text.replace("\r\n", "\n").split("\n"):
            line = line.strip()
            if not line:
                continue
            # Try Chinese colon first, then ASCII colon
            for sep in ("：", ":"):
                idx = line.find(sep)
                if idx > 0:
                    k = line[:idx].strip()
                    v = line[idx + len(sep):].strip()
                    out[k] = v
                    break
        return out

    @staticmethod
    def _try_json_block(text: str):
        """Try to extract JSON array/object from text."""
        # Find first [ or {
        for i, ch in enumerate(text):
            if ch in ("[", "{"):
                try:
                    return json.loads(text[i:])
                except json.JSONDecodeError:
                    pass
        return None

    # ── high-level API ───────────────────────────────────────

    def product_detail(self, asin: str, site: str = "US") -> dict:
        """Get ASIN detail. Returns parsed dict with nodeId, price, rating, etc."""
        raw = self.call_tool("product_detail", {"asin": asin, "amzSite": site})
        return self._parse_kv(raw)

    def product_trend(self, asin: str, trend_type: str = "SalesVolume", site: str = "US") -> list:
        """Get ASIN monthly trend. Returns [{"month": "YYYY-MM", "value": int}, ...]."""
        raw = self.call_tool("product_trend", {
            "asin": asin, "productTrendType": trend_type, "amzSite": site,
        })
        return self._parse_trend(raw)

    def category_trend(self, node_id: str, trend_index: str = "SalesCount", site: str = "US") -> list:
        """Get category monthly trend (~25 months). Returns [{"month": "YYYY-MM", "value": int}, ...]."""
        raw = self.call_tool("category_trend", {
            "nodeId": node_id, "trendIndex": trend_index, "amzSite": site,
        })
        return self._parse_trend(raw)

    def category_report(self, node_id: str, site: str = "US") -> list:
        """Get category Top 100 products (real-time). Returns list of dicts."""
        raw = self.call_tool("category_report", {"nodeId": node_id, "amzSite": site})
        parsed = self._try_json_block(raw)
        if isinstance(parsed, dict) and "Top100产品" in parsed:
            return parsed["Top100产品"]
        if isinstance(parsed, list):
            return parsed
        return []

    def category_report_history(self, node_id: str, start: str, end: str, site: str = "US") -> list:
        """Get category Top 100 historical (max 40-day window). Returns list of dicts."""
        raw = self.call_tool("category_report_from_history", {
            "nodeId": node_id, "startDate": start, "endDate": end, "amzSite": site,
        })
        parsed = self._try_json_block(raw)
        if isinstance(parsed, dict) and "Top100产品" in parsed:
            return parsed["Top100产品"]
        if isinstance(parsed, list):
            return parsed
        return []

    def category_name_search(self, name: str, site: str = "US") -> list:
        """Search category by name. Returns [{"Name": "...", "NodeId": "..."}, ...]."""
        raw = self.call_tool("category_name_search", {"categoryName": name, "amzSite": site})
        parsed = self._try_json_block(raw)
        return parsed if isinstance(parsed, list) else []


if __name__ == "__main__":
    import sys
    client = SorftimeClient()

    if len(sys.argv) < 2:
        print("Usage: python3 sorftime_client.py <asin>")
        print("       python3 sorftime_client.py --category-trend <nodeId>")
        sys.exit(1)

    if sys.argv[1] == "--category-trend" and len(sys.argv) >= 3:
        node_id = sys.argv[2]
        trend = client.category_trend(node_id)
        print(f"Category {node_id} trend ({len(trend)} months):")
        for t in trend:
            print(f"  {t['month']}: {t['value']:,}")
    else:
        asin = sys.argv[1]
        print(f"=== Product Detail: {asin} ===")
        detail = client.product_detail(asin)
        for k, v in detail.items():
            print(f"  {k}: {v}")

        node_id = detail.get("所属nodeid") or detail.get("nodeId")
        if node_id:
            print(f"\n=== Category Trend (nodeId={node_id}) ===")
            trend = client.category_trend(node_id)
            for t in trend[-6:]:
                print(f"  {t['month']}: {t['value']:,}")
