"""
Podzamenu Lookup Service
FastAPI service for VIN/FRAME lookups via Playwright.
Sources: podzamenu.ru (EU/JP/KR/RU), prof-rf (Chinese VIN).

Env:
  PODZAMENU_BASE_URL  - base URL (default https://podzamenu.ru)
  PROF_RF_BASE_URL    - prof-rf base (default https://xn--80aagvgd7a1ae.xn--p1acf)
  SOURCE_STRATEGY     - "auto" | "podzamenu" | "prof_rf" (auto: China VIN -> prof_rf)
  HEADLESS            - browser headless (default true)
  SCREENSHOT_ON_ERROR - save base64 screenshot on error (default false)
"""

import asyncio
import base64
import os
import re
from typing import Optional
from urllib.parse import quote

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel

app = FastAPI(title="Podzamenu Lookup Service")

PORT = int(os.environ.get("PORT", "8200"))
PODZAMENU_BASE_URL = os.environ.get("PODZAMENU_BASE_URL", "https://podzamenu.ru").rstrip("/")
PROF_RF_BASE_URL = os.environ.get("PROF_RF_BASE_URL", "https://xn--80aagvgd7a1ae.xn--p1acf").rstrip("/")
SOURCE_STRATEGY = (os.environ.get("SOURCE_STRATEGY", "auto") or "auto").lower()
HEADLESS = os.environ.get("HEADLESS", "true").lower() in ("true", "1", "yes")
SCREENSHOT_ON_ERROR = os.environ.get("SCREENSHOT_ON_ERROR", "false").lower() in ("true", "1", "yes")
LOOKUP_TIMEOUT_MS = 30_000
MAX_RETRIES = 1  # retry only on timeout


def is_china_vin(vin: str) -> bool:
    """Return True if VIN starts with L (China)."""
    return bool(vin and vin.upper().strip().startswith("L"))

# One browser per process
_browser = None
_playwright = None
_lookup_semaphore = asyncio.Semaphore(2)


class LookupRequest(BaseModel):
    idType: str  # "VIN" | "FRAME"
    value: str


class GearboxOemCandidate(BaseModel):
    oem: str
    name: str


class GearboxInfo(BaseModel):
    model: Optional[str] = None
    oem: Optional[str] = None
    oemCandidates: list[GearboxOemCandidate] = []
    oemStatus: str  # "FOUND" | "NOT_FOUND" | "NOT_AVAILABLE"


class LookupResponse(BaseModel):
    vehicleMeta: dict
    gearbox: GearboxInfo
    evidence: dict


# Link text to find "Коробка передач" page (case-insensitive)
GEARBOX_LINK_TEXTS = ["коробка передач", "кпп"]

# Name filter: include if contains any (gearbox-related)
OEM_INCLUDE_PATTERNS = [
    "кпп", "акпп", "коробк", "коробка передач", "коробка передач в сборе",
    "мкп", "акп", "вариатор", "вариатор в сборе", "cvt",
    "трансмиссия", "transmission", "gearbox", "gear box",
    "at transmission", "mt transmission",
    "автоматическая коробка", "механическая коробка",
]

# Name filter: exclude if contains any
OEM_EXCLUDE_PATTERNS = [
    "масло", "шайб", "фиксатор", "шумоизоляц", "болт", "гайк", "уплотн",
    "прокладк", "сальник", "фильтр", "датчик", "крепеж",
]

# Priority: candidates with these in name rank higher
OEM_PRIORITY_TERMS = ["в сборе", "трансмиссия", "коробка передач"]

# Table column headers (case-insensitive)
OEM_HEADERS = ["oem", "оем"]
NAME_HEADERS = ["наименование", "название", "name"]


# Not-found text patterns (Russian) - podzamenu
NOT_FOUND_PATTERNS = [
    r"не\s+найдено",
    r"ничего\s+не\s+найдено",
    r"не\s+найден",
    r"данные\s+не\s+найдены",
    r"автомобиль\s+не\s+найден",
    r"vehicle\s+not\s+found",
    r"no\s+results",
]

# prof_rf specific
PROF_RF_NOT_FOUND_PATTERNS = [
    r"отсутствует\s+в\s+базе\s+данных",
    r"vin\s+код\s+отсутствует",
    r"данный\s+vin\s+код\s+отсутствует",
    r"не\s+найден",
]

# Labels for vehicle meta
META_LABELS = {
    "марка": "make",
    "модель": "model",
    "год": "year",
    "двигатель": "engine",
    "engine": "engine",
    "make": "make",
    "model": "model",
    "year": "year",
}


async def _get_browser():
    """Lazy-init single browser instance."""
    global _browser, _playwright
    if _browser is None:
        from playwright.async_api import async_playwright
        _playwright = await async_playwright().start()
        _browser = await _playwright.chromium.launch(
            headless=HEADLESS,
            args=[
                "--no-sandbox",
                "--disable-setuid-sandbox",
                "--disable-dev-shm-usage",
                "--disable-gpu",
            ],
        )
    return _browser


def _build_podzamenu_url(value: str) -> str:
    """Build direct search URL. Podzamenu uses vin= for both VIN and frame."""
    return f"{PODZAMENU_BASE_URL}/search-vehicle?vin={quote(value)}"


def _build_prof_rf_url(vin: str) -> str:
    """Build prof_rf search URL."""
    return f"{PROF_RF_BASE_URL}/search?query={quote(vin)}&type=vin"


def _is_not_found(html: str, patterns: Optional[list[str]] = None) -> bool:
    """Check if page indicates 'not found'."""
    text = html.lower()
    pats = patterns if patterns is not None else NOT_FOUND_PATTERNS
    for pat in pats:
        if re.search(pat, text, re.IGNORECASE):
            return True
    return False


def _extract_model_from_page(html: str, selectors_used: list[str]) -> Optional[str]:
    """
    Extract gearbox.model from search page HTML.
    Returns model string or None.
    """
    model = None

    # Strategy 1: Look for table/definition list structure (dt/dd, th/td, label+value)
    table_patterns = [
        (r"<dt[^>]*>\s*кпп\s*</dt>\s*<dd[^>]*>\s*([^<]+)\s*</dd>", "dt/dd (КПП)"),
        (r"<dt[^>]*>\s*коробка[^<]*</dt>\s*<dd[^>]*>\s*([^<]+)\s*</dd>", "dt/dd (коробка)"),
        (r"<th[^>]*>\s*кпп\s*</th>\s*<td[^>]*>\s*([^<]+)\s*</td>", "th/td (КПП)"),
        (r"<th[^>]*>\s*коробка[^<]*</th>\s*<td[^>]*>\s*([^<]+)\s*</td>", "th/td (коробка)"),
        (r"<td[^>]*>\s*кпп\s*</td>\s*<td[^>]*>\s*([^<]+)\s*</td>", "td/td (КПП)"),
        (r"кпп\s*[:：]\s*([a-zA-Z0-9\-_\s]+?)(?:<|$)", "inline (КПП:)"),
        (r"коробка\s*[:：]\s*([a-zA-Z0-9\-_\s]+?)(?:<|$)", "inline (коробка:)"),
        (r"transmission\s*[:：]\s*([a-zA-Z0-9\-_\s]+?)(?:<|$)", "inline (transmission:)"),
        (r"gearbox\s*[:：]\s*([a-zA-Z0-9\-_\s]+?)(?:<|$)", "inline (gearbox:)"),
    ]
    for pat, name in table_patterns:
        m = re.search(pat, html, re.IGNORECASE | re.DOTALL)
        if m:
            val = re.sub(r"\s+", " ", m.group(1).strip())
            if len(val) >= 2 and len(val) <= 80:
                model = val
                selectors_used.append(f"gearbox.model:{name}")
                return model

    # Strategy 2: Look for common OEM gearbox codes (Aisin, ZF, 6HP, etc.)
    oem_codes = [
        r"\b(6HP\d{2}[A-Z]?)\b",
        r"\b(8HP\d{2}[A-Z]?)\b",
        r"\b(AW\d{2}[A-Z]*)\b",
        r"\b(A[345]\d{3}[A-Z]*)\b",
        r"\b(TF-\d{2}[A-Z]*)\b",
        r"\b(ZF\s*\d+[A-Z]*)\b",
        r"\b(09G|09K|0AW|0B5|0B6)\b",
        r"\b([A-Z]{2,4}\s*-?\s*\d{2,4}[A-Z]?)\b",
    ]
    for code_pat in oem_codes:
        m = re.search(code_pat, html, re.IGNORECASE)
        if m:
            snippet = html[max(0, m.start() - 100) : m.end() + 50].lower()
            if any(lbl in snippet for lbl in ["кпп", "коробка", "transmission", "gearbox"]):
                model = m.group(1).strip().replace(" ", "")
                selectors_used.append("gearbox.model:oem_code_regex")
                return model

    # Strategy 3: Any text in a result block that looks like OEM
    block_pat = r"(?:результат|vehicle|автомобиль|характеристики)[^>]*>[\s\S]{0,500}?([A-Z]{2,4}[-\s]?\d{2,4}[A-Z]?)"
    m = re.search(block_pat, html.lower(), re.IGNORECASE)
    if m:
        model = m.group(1).strip().replace(" ", "")
        selectors_used.append("gearbox.model:result_block_regex")
        return model

    return None


def _extract_meta_from_page(html: str) -> dict:
    """Extract vehicle meta (марка, модель, год, двигатель) from HTML."""
    meta: dict = {}
    html_lower = html.lower()
    for ru_label, en_key in META_LABELS.items():
        if en_key in meta:
            continue
        pat = rf"{re.escape(ru_label)}\s*[:：]\s*([^<\n]+)"
        m = re.search(pat, html_lower, re.IGNORECASE)
        if m:
            meta[en_key] = m.group(1).strip()[:200]
    return meta


def _parse_oem_table(html: str) -> list[tuple[str, str]]:
    """
    Find table with OEM and Наименование columns, return list of (oem, name).
    Returns [] if table not found.
    """
    rows: list[tuple[str, str]] = []

    # Find tables (including nested in thead/tbody)
    table_re = re.compile(r"<table[^>]*>([\s\S]*?)</table>", re.IGNORECASE | re.DOTALL)
    for table_match in table_re.finditer(html):
        table_html = table_match.group(1)
        table_lower = table_html.lower()

        has_oem = any(h in table_lower for h in OEM_HEADERS)
        has_name = any(h in table_lower for h in NAME_HEADERS)
        if not (has_oem and has_name):
            continue

        # Get first row as header (from thead or first tr)
        thead_match = re.search(r"<thead[^>]*>([\s\S]*?)</thead>", table_html, re.I | re.DOTALL)
        header_html = thead_match.group(1) if thead_match else table_html

        header_re = re.compile(r"<t[hd][^>]*>([^<]*)</t[hd]>", re.IGNORECASE)
        header_cells: list[str] = []
        first_tr = re.search(r"<tr[^>]*>([\s\S]*?)</tr>", header_html, re.I | re.DOTALL)
        if first_tr:
            for m in header_re.finditer(first_tr.group(1)):
                header_cells.append(m.group(1).strip().lower())
        if not header_cells:
            continue

        oem_idx = next((i for i, c in enumerate(header_cells) if any(h in c for h in OEM_HEADERS)), -1)
        name_idx = next((i for i, c in enumerate(header_cells) if any(h in c for h in NAME_HEADERS)), -1)
        if oem_idx < 0 or name_idx < 0:
            continue

        # Parse data rows (skip header row when no tbody)
        tbody_match = re.search(r"<tbody[^>]*>([\s\S]*?)</tbody>", table_html, re.I | re.DOTALL)
        body_html = tbody_match.group(1) if tbody_match else table_html
        tr_re = re.compile(r"<tr[^>]*>([\s\S]*?)</tr>", re.IGNORECASE | re.DOTALL)
        td_re = re.compile(r"<t[hd][^>]*>([\s\S]*?)</t[hd]>", re.IGNORECASE | re.DOTALL)

        tr_matches = list(tr_re.finditer(body_html))
        for idx, tr_match in enumerate(tr_matches):
            if not tbody_match and idx == 0:
                continue
            cells: list[str] = []
            for td_match in td_re.finditer(tr_match.group(1)):
                cells.append(re.sub(r"<[^>]+>", "", td_match.group(1)).strip())
            if len(cells) > max(oem_idx, name_idx):
                oem = cells[oem_idx].strip()[:100]
                name = cells[name_idx].strip()[:500]
                if oem or name:
                    rows.append((oem, name))
        if rows:
            return rows

    return rows


def _has_priority_term(name: str) -> bool:
    """Check if name contains a priority term (в сборе, трансмиссия, коробка передач)."""
    n = name.lower()
    return any(t in n for t in OEM_PRIORITY_TERMS)


def _filter_oem_candidates(
    candidates: list[tuple[str, str]],
    sort_by_priority: bool = False,
) -> list[tuple[str, str]]:
    """Filter candidates: include by OEM_INCLUDE_PATTERNS, exclude by OEM_EXCLUDE_PATTERNS."""
    result: list[tuple[str, str]] = []
    for oem, name in candidates:
        name_lower = name.lower()
        if any(ex in name_lower for ex in OEM_EXCLUDE_PATTERNS):
            continue
        if any(inc in name_lower for inc in OEM_INCLUDE_PATTERNS):
            result.append((oem, name))
    if sort_by_priority:
        result.sort(key=lambda x: (0 if _has_priority_term(x[1]) else 1, x[1]))
    return result


async def _do_lookup_podzamenu(id_type: str, value: str, evidence: dict) -> LookupResponse:
    """Perform lookup via podzamenu. Raises HTTPException on not-found or parse fail."""
    evidence["source"] = "podzamenu"
    browser = await _get_browser()
    context = await browser.new_context(
        user_agent="Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        viewport={"width": 1280, "height": 720},
        locale="ru-RU",
    )
    page = None
    try:
        page = await context.new_page()
        url = _build_podzamenu_url(value)
        evidence["finalUrl"] = url

        await page.goto(url, wait_until="networkidle", timeout=LOOKUP_TIMEOUT_MS)

        # Wait for result area
        result_selectors = [
            "[class*='result']", "[class*='vehicle']", "[class*='search-result']",
            "main", "article", ".content", "#content", "body",
        ]
        for sel in result_selectors:
            try:
                el = page.locator(sel).first
                await el.wait_for(state="visible", timeout=3000)
                break
            except Exception:
                pass

        await asyncio.sleep(1)
        html = await page.content()
        evidence["finalUrl"] = page.url

        if _is_not_found(html):
            raise HTTPException(status_code=404, detail={"error": "NOT_FOUND"})

        selectors_used: list[str] = []
        meta = _extract_meta_from_page(html)
        gearbox_model = _extract_model_from_page(html, selectors_used)

        if not gearbox_model:
            evidence["selectorsUsed"] = selectors_used
            evidence["parseError"] = "gearbox.model not found"
            if SCREENSHOT_ON_ERROR and page:
                screenshot = await page.screenshot(type="png")
                evidence["screenshotOnError"] = base64.b64encode(screenshot).decode()
            evidence["htmlSnippet"] = html[:3000] if len(html) > 3000 else html
            raise HTTPException(
                status_code=500,
                detail={"error": "PARSE_FAILED", "evidence": evidence},
            )

        gearbox: GearboxInfo = GearboxInfo(
            model=gearbox_model,
            oem=None,
            oemCandidates=[],
            oemStatus="NOT_AVAILABLE",
        )

        # B) Find and click link "Коробка передач" or "КПП"
        gearbox_link_clicked = False
        link_selectors = [
            'a:has-text("Коробка передач")',
            'a:has-text("КПП")',
            '[role="link"]:has-text("Коробка передач")',
            '[role="link"]:has-text("КПП")',
            'a >> text=/коробка передач/i',
            'a >> text=/кпп/i',
        ]
        for link_sel in link_selectors:
            try:
                loc = page.locator(link_sel)
                if await loc.count() > 0:
                    await loc.first.click(timeout=5000)
                    gearbox_link_clicked = True
                    selectors_used.append(f"gearbox_link:{link_sel[:50]}")
                    break
            except Exception:
                continue

        if not gearbox_link_clicked:
            try:
                loc = page.get_by_role("link", name=re.compile(r"коробка передач|кпп", re.I))
                if await loc.count() > 0:
                    await loc.first.click(timeout=5000)
                    gearbox_link_clicked = True
                    selectors_used.append("gearbox_link:getByRole")
            except Exception:
                pass

        if gearbox_link_clicked:
            await asyncio.sleep(1)
            try:
                await page.wait_for_load_state("networkidle", timeout=10000)
            except Exception:
                pass

            # Wait for table
            table_selectors = [
                "table",
                "[role='table']",
                ".table",
                "[class*='table']",
            ]
            for ts in table_selectors:
                try:
                    await page.locator(ts).first.wait_for(state="visible", timeout=5000)
                    break
                except Exception:
                    pass

            await asyncio.sleep(0.5)
            gearbox_html = await page.content()
            evidence["finalUrl"] = page.url

            candidates_raw = _parse_oem_table(gearbox_html)
            gearbox.oemCandidates = [
                GearboxOemCandidate(oem=o, name=n) for o, n in candidates_raw[:10]
            ]

            if candidates_raw:
                filtered = _filter_oem_candidates(candidates_raw)
                if filtered:
                    gearbox.oem = filtered[0][0] or None
                    gearbox.oemStatus = "FOUND"
                else:
                    gearbox.oemStatus = "NOT_FOUND"
            else:
                evidence["gearboxPageParseFailed"] = True
                evidence["selectorsUsed"] = selectors_used
        else:
            evidence["gearboxLinkNotFound"] = True

        evidence["selectorsUsed"] = selectors_used
        return LookupResponse(
            vehicleMeta=meta,
            gearbox=gearbox,
            evidence=evidence,
        )
    finally:
        await context.close()


@app.post("/lookup", response_model=LookupResponse)
async def lookup(request: LookupRequest):
    """Lookup vehicle info by VIN or FRAME via podzamenu.ru."""
    if not request.value or not request.value.strip():
        raise HTTPException(status_code=400, detail="value is required")

    evidence: dict = {"finalUrl": "", "selectorsUsed": []}
    last_error: Optional[Exception] = None

    for attempt in range(MAX_RETRIES + 1):
        try:
            async with _lookup_semaphore:
                return await _do_lookup_routed(request.idType, request.value, evidence)
        except HTTPException:
            raise
        except Exception as e:
            last_error = e
            is_timeout = "timeout" in str(e).lower() or "Timeout" in type(e).__name__
            if is_timeout and attempt < MAX_RETRIES:
                continue
            break

    err_msg = str(last_error) if last_error else "Unknown error"
    evidence["error"] = err_msg
    if SCREENSHOT_ON_ERROR:
        try:
            browser = await _get_browser()
            ctx = await browser.new_context()
            page = await ctx.new_page()
            await page.goto(_build_podzamenu_url(request.value), timeout=5000)
            screenshot = await page.screenshot(type="png")
            evidence["screenshotOnError"] = base64.b64encode(screenshot).decode()
            await ctx.close()
        except Exception:
            pass
    raise HTTPException(status_code=500, detail={"error": "LOOKUP_ERROR", "message": err_msg, "evidence": evidence})


# prof_rf: header patterns "Коробка передач 3043001600" / "Трансмиссия <OEM>"
PROF_RF_HEADER_PATTERN = re.compile(
    r"(Коробка\s+передач|Трансмиссия)\s+([A-Z0-9]{6,20})",
    re.IGNORECASE,
)


def _extract_prof_rf_header_oem(html: str, selectors_used: list[str]) -> Optional[tuple[str, str]]:
    """
    Extract from headers like "Коробка передач 3043001600" or "Трансмиссия 3043001600".
    Returns (model_text, oem) or None.
    """
    for m in PROF_RF_HEADER_PATTERN.finditer(html):
        prefix = m.group(1).strip()
        oem = m.group(2).strip()
        model_text = f"{prefix} {oem}"
        selectors_used.append("prof_rf:header_oem")
        return (model_text, oem)
    return None


def _parse_prof_rf_blocks(html: str) -> tuple[list[tuple[str, str, str]], list[tuple[str, str]]]:
    """
    Parse blocks Оригинал, Аналоги, Копии. Returns (blocked_rows, all_table_rows).
    blocked_rows: [(oem, name, block_type), ...]
    """
    blocked: list[tuple[str, str, str]] = []
    block_headers = ["Оригинал", "Аналоги", "Копии"]
    html_lower = html.lower()

    for block_name in block_headers:
        pat = re.compile(
            rf"(?:^|>)\s*{re.escape(block_name)}\s*(?:<|$|[\s:])",
            re.IGNORECASE,
        )
        for m in pat.finditer(html):
            start = m.end()
            next_block = len(html)
            for other in block_headers:
                if other.lower() == block_name.lower():
                    continue
                other_pat = re.compile(
                    rf"(?:^|>)\s*{re.escape(other)}\s*(?:<|$|[\s:])",
                    re.IGNORECASE,
                )
                om = other_pat.search(html, start)
                if om and om.start() < next_block:
                    next_block = om.start()
            section = html[start:next_block]
            table_matches = re.findall(r"<table[^>]*>[\s\S]*?</table>", section, re.I | re.DOTALL)
            for table_html in table_matches:
                rows = _parse_oem_table_from_html(table_html)
                for oem_val, name_val in rows:
                    if oem_val or name_val:
                        blocked.append((oem_val, name_val, block_name))

    all_rows = _parse_oem_table(html)
    return blocked, all_rows


def _parse_oem_table_from_html(table_html: str) -> list[tuple[str, str]]:
    """Parse OEM table rows from a single table HTML."""
    rows: list[tuple[str, str]] = []
    table_lower = table_html.lower()
    has_oem = any(h in table_lower for h in OEM_HEADERS)
    has_name = any(h in table_lower for h in NAME_HEADERS)
    if not (has_oem and has_name):
        return rows
    header_re = re.compile(r"<t[hd][^>]*>([^<]*)</t[hd]>", re.I)
    thead = re.search(r"<thead[^>]*>([\s\S]*?)</thead>", table_html, re.I | re.DOTALL)
    header_html = thead.group(1) if thead else table_html
    first_tr = re.search(r"<tr[^>]*>([\s\S]*?)</tr>", header_html, re.I | re.DOTALL)
    header_cells: list[str] = []
    if first_tr:
        for mm in header_re.finditer(first_tr.group(1)):
            header_cells.append(mm.group(1).strip().lower())
    oem_idx = next((i for i, c in enumerate(header_cells) if any(h in c for h in OEM_HEADERS)), -1)
    name_idx = next((i for i, c in enumerate(header_cells) if any(h in c for h in NAME_HEADERS)), -1)
    if oem_idx < 0 or name_idx < 0:
        return rows
    tbody = re.search(r"<tbody[^>]*>([\s\S]*?)</tbody>", table_html, re.I | re.DOTALL)
    body_html = tbody.group(1) if tbody else table_html
    tr_re = re.compile(r"<tr[^>]*>([\s\S]*?)</tr>", re.I | re.DOTALL)
    td_re = re.compile(r"<t[hd][^>]*>([\s\S]*?)</t[hd]>", re.I | re.DOTALL)
    tr_matches = list(tr_re.finditer(body_html))
    for idx, tr_m in enumerate(tr_matches):
        if not tbody and idx == 0:
            continue
        cells = [re.sub(r"<[^>]+>", "", td_m.group(1)).strip() for td_m in td_re.finditer(tr_m.group(1))]
        if len(cells) > max(oem_idx, name_idx):
            rows.append((cells[oem_idx].strip()[:100], cells[name_idx].strip()[:500]))
    return rows


def _extract_from_prof_rf(html: str, selectors_used: list[str]) -> tuple[dict, Optional[str], Optional[str], list[tuple[str, str]]]:
    """
    Extract vehicleMeta, gearbox.model, gearbox.oem, and oemCandidates from prof_rf page.
    Returns (meta, model, oem, candidates_raw).
    """
    meta = _extract_meta_from_page(html)

    model: Optional[str] = None
    oem: Optional[str] = None

    # 1) Header extractor: "Коробка передач 3043001600" / "Трансмиссия 3043001600"
    header_result = _extract_prof_rf_header_oem(html, selectors_used)
    if header_result:
        model, oem = header_result
        candidates_raw = _parse_oem_table(html)
        if candidates_raw:
            selectors_used.append("prof_rf:table_candidates")
        else:
            candidates_raw = [(oem, model)] if oem else []
        return meta, model, oem, candidates_raw

    # 2) Parse blocks Оригинал / Аналоги / Копии
    blocked_rows, candidates_raw = _parse_prof_rf_blocks(html)
    original_oems: list[tuple[str, str]] = []
    for oem_val, name_val, block_type in blocked_rows:
        if block_type.lower() == "оригинал":
            name_lower = name_val.lower()
            if any(ex in name_lower for ex in OEM_EXCLUDE_PATTERNS):
                continue
            if any(inc in name_lower for inc in OEM_INCLUDE_PATTERNS):
                original_oems.append((oem_val, name_val))
    if original_oems:
        selectors_used.append("prof_rf:original_block")
        filtered = _filter_oem_candidates(original_oems, sort_by_priority=True)
        if filtered:
            oem = filtered[0][0] or None
            model = model or filtered[0][1]
        else:
            oem = original_oems[0][0] or None
            model = model or original_oems[0][1]

    # 3) Fallback: table candidates with filter and priority
    if not oem and candidates_raw:
        selectors_used.append("prof_rf:table_candidates")
        filtered = _filter_oem_candidates(candidates_raw, sort_by_priority=True)
        if filtered:
            oem = filtered[0][0] or None
            model = model or filtered[0][1]

    if not model:
        model = _extract_model_from_page(html, selectors_used)

    return meta, model, oem, candidates_raw


async def _do_lookup_prof_rf(vin: str, evidence: dict) -> LookupResponse:
    """Perform lookup via prof_rf (Chinese autos). Raises HTTPException on not-found."""
    evidence["source"] = "prof_rf"
    browser = await _get_browser()
    context = await browser.new_context(
        user_agent="Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        viewport={"width": 1280, "height": 720},
        locale="ru-RU",
    )
    try:
        page = await context.new_page()
        url = _build_prof_rf_url(vin)
        evidence["finalUrl"] = url

        await page.goto(url, wait_until="networkidle", timeout=LOOKUP_TIMEOUT_MS)

        for sel in ["main", "article", ".content", "#content", "body"]:
            try:
                await page.locator(sel).first.wait_for(state="visible", timeout=3000)
                break
            except Exception:
                pass

        await asyncio.sleep(1)
        html = await page.content()
        evidence["finalUrl"] = page.url

        if _is_not_found(html, PROF_RF_NOT_FOUND_PATTERNS):
            raise HTTPException(status_code=404, detail={"error": "NOT_FOUND"})

        selectors_used: list[str] = []
        meta, model, oem, candidates_raw = _extract_from_prof_rf(html, selectors_used)
        evidence["selectorsUsed"] = selectors_used

        if not model and not oem:
            evidence["parseError"] = "no gearbox.model nor gearbox.oem"
            if SCREENSHOT_ON_ERROR:
                try:
                    screenshot = await page.screenshot(type="png")
                    evidence["screenshotOnError"] = base64.b64encode(screenshot).decode()
                except Exception:
                    pass
            raise HTTPException(
                status_code=500,
                detail={"error": "PARSE_FAILED", "evidence": evidence},
            )

        oem_status = "FOUND" if oem else "NOT_AVAILABLE"
        gearbox = GearboxInfo(
            model=model,
            oem=oem,
            oemCandidates=[GearboxOemCandidate(oem=ov, name=nv) for ov, nv in candidates_raw[:10]],
            oemStatus=oem_status,
        )
        return LookupResponse(vehicleMeta=meta, gearbox=gearbox, evidence=evidence)
    finally:
        await context.close()


def _add_source_evidence(resp: LookupResponse, source_tried: list[str], source_selected: str) -> None:
    """Add sourceTried and sourceSelected to response evidence."""
    resp.evidence["sourceTried"] = source_tried
    resp.evidence["sourceSelected"] = source_selected


async def _do_lookup_routed(id_type: str, value: str, evidence: dict) -> LookupResponse:
    """
    Route to appropriate source.
    auto: VIN -> podzamenu first; 404 -> prof_rf; success without FOUND -> try prof_rf, prefer prof_rf if FOUND.
    FRAME: only podzamenu (prof_rf not supported).
    """
    source_tried: list[str] = []

    # FRAME: only podzamenu (prof_rf does not support FRAME)
    if id_type == "FRAME":
        if SOURCE_STRATEGY == "prof_rf":
            raise HTTPException(status_code=400, detail={"error": "UNSUPPORTED_ID_TYPE"})
        ev = {**evidence, "finalUrl": "", "selectorsUsed": []}
        result = await _do_lookup_podzamenu(id_type, value, ev)
        _add_source_evidence(result, ["podzamenu"], "podzamenu")
        return result

    # VIN
    if SOURCE_STRATEGY == "podzamenu":
        ev = {**evidence, "finalUrl": "", "selectorsUsed": []}
        result = await _do_lookup_podzamenu(id_type, value, ev)
        _add_source_evidence(result, ["podzamenu"], "podzamenu")
        return result

    if SOURCE_STRATEGY == "prof_rf":
        ev = {**evidence, "finalUrl": "", "selectorsUsed": []}
        result = await _do_lookup_prof_rf(value, ev)
        _add_source_evidence(result, ["prof_rf"], "prof_rf")
        return result

    # auto: always try podzamenu first for VIN
    ev = {**evidence, "finalUrl": "", "selectorsUsed": []}
    try:
        result = await _do_lookup_podzamenu(id_type, value, ev)
        source_tried.append("podzamenu")

        if result.gearbox.oemStatus == "FOUND":
            _add_source_evidence(result, source_tried, "podzamenu")
            return result

        # podzamenu success but no FOUND -> try prof_rf
        ev2 = {**evidence, "finalUrl": "", "selectorsUsed": []}
        try:
            result2 = await _do_lookup_prof_rf(value, ev2)
            source_tried.append("prof_rf")
            if result2.gearbox.oemStatus == "FOUND":
                _add_source_evidence(result2, source_tried, "prof_rf")
                return result2
        except HTTPException:
            pass
        _add_source_evidence(result, source_tried, "podzamenu")
        return result

    except HTTPException as e:
        if e.status_code == 404:
            detail = getattr(e, "detail", None)
            if isinstance(detail, dict) and detail.get("error") == "NOT_FOUND":
                source_tried.append("podzamenu")
                ev2 = {**evidence, "finalUrl": "", "selectorsUsed": []}
                try:
                    result2 = await _do_lookup_prof_rf(value, ev2)
                    source_tried.append("prof_rf")
                    _add_source_evidence(result2, source_tried, "prof_rf")
                    return result2
                except HTTPException:
                    pass
        raise


@app.on_event("shutdown")
async def shutdown():
    global _browser, _playwright
    if _browser:
        await _browser.close()
        _browser = None
    if _playwright:
        await _playwright.stop()
        _playwright = None


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=PORT)


# --- Test reference ---
# auto: VIN always tries podzamenu first; 404 -> prof_rf; no FOUND -> try prof_rf
# EU: WV1ZZZ7HZ8H020981 | China: LVSHCAMB0CE123456
# curl -X POST http://localhost:8200/lookup -H "Content-Type: application/json" \
#   -d '{"idType": "VIN", "value": "WV1ZZZ7HZ8H020981"}'
# curl -X POST http://localhost:8200/lookup -H "Content-Type: application/json" \
#   -d '{"idType": "VIN", "value": "LVSHCAMB0CE123456"}'
