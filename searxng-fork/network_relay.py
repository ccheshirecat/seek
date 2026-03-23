"""
Relay override for SearXNG's network module.
Appended to searx/network.py at build time so this definition wins.

All outbound HTTP requests are forwarded to the Rust wreq-relay service,
which executes them with Chrome 137 TLS/JA4/HTTP2 emulation via rotating
ISP proxies. SearXNG's own headers are intentionally dropped to avoid a
header/TLS fingerprint mismatch.
"""

import httpx as _httpx
from searx.proxy_rotator import rotator as _rotator

_WREQ_RELAY_URL = "http://wreq-relay:3000/fetch"


class _MockResponse:
    """Minimal httpx.Response shim so SearXNG's HTML parsers don't crash."""

    def __init__(self, status_code: int, text: str, url: str):
        self.status_code = status_code
        self.text = text
        self.url = url
        self.content = text.encode("utf-8")
        self.ok = 200 <= status_code < 300
        self.headers: dict = {}

    def json(self):
        import json
        return json.loads(self.text)

    def raise_for_status(self):
        if not self.ok:
            raise _httpx.HTTPStatusError(
                f"HTTP {self.status_code}",
                request=None,  # type: ignore[arg-type]
                response=None,  # type: ignore[arg-type]
            )


async def _relay(url: str) -> _MockResponse:
    proxy = _rotator.get_next()
    payload = {"url": str(url), "proxy": proxy}
    try:
        async with _httpx.AsyncClient(timeout=20.0) as _client:
            relay_resp = await _client.post(_WREQ_RELAY_URL, json=payload)
            data = relay_resp.json()
        return _MockResponse(
            status_code=data.get("status_code", 500),
            text=data.get("html", ""),
            url=str(url),
        )
    except Exception as exc:
        return _MockResponse(500, str(exc), str(url))


# -----------------------------------------------------------------
# Override SearXNG's core network functions (async variants).
# Because this block is appended to network.py these definitions
# shadow any previously defined `request`, `get`, and `post`.
# -----------------------------------------------------------------

async def request(url, **kwargs):  # noqa: F811
    return await _relay(url)


async def get(url, **kwargs):  # noqa: F811
    return await _relay(url)


async def post(url, **kwargs):  # noqa: F811
    return await _relay(url)
