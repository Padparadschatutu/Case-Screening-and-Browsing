from __future__ import annotations

import os
import threading
from collections import OrderedDict
from pathlib import Path

import pandas as pd
from flask import Flask, jsonify, request, send_file

try:
    from .nifti_min import get_volume_info, render_slice_png  # type: ignore
    from .storage import LabelStore  # type: ignore
except Exception:  # pragma: no cover
    from nifti_min import get_volume_info, render_slice_png
    from storage import LabelStore


ROOT = Path(__file__).resolve().parents[1]  # /home/Head
EXCEL_PATH = ROOT / "数据_筛选结果.xlsx"
STROKE_ROOT = Path("/home/Head_Stroke")
LABELS_PATH = ROOT / "labels" / "labels.json"

# In-memory cache for rendered slice images (speeds up scroll/drag with prefetch).
_SLICE_CACHE_MAX = int(os.environ.get("SLICE_CACHE_MAX", "256"))
_SLICE_CACHE: "OrderedDict[tuple, bytes]" = OrderedDict()
_SLICE_CACHE_LOCK = threading.Lock()

def _env_truthy(name: str, default: str = "0") -> bool:
    v = os.environ.get(name, default)
    return str(v).strip().lower() in ("1", "true", "yes", "y", "on")


def _norm_barcode(v: object) -> str:
    if v is None or (isinstance(v, float) and pd.isna(v)):
        return ""
    return str(v).strip()


def _load_cases() -> pd.DataFrame:
    df = pd.read_excel(EXCEL_PATH, sheet_name="all_with_labels")
    df = df.copy()
    df["条码号"] = df["条码号"].map(_norm_barcode)
    df["cta_category"] = df["cta_category"].map(_norm_barcode)
    if "CTA检查结论" in df.columns:
        df["CTA检查结论"] = df["CTA检查结论"].map(_norm_barcode)
    if "CTA报告：检查所见" in df.columns:
        df["CTA报告：检查所见"] = df["CTA报告：检查所见"].map(_norm_barcode)
    df = df[df["条码号"] != ""]
    cols = ["条码号", "cta_category"]
    if "CTA检查结论" in df.columns:
        cols.append("CTA检查结论")
    if "CTA报告：检查所见" in df.columns:
        cols.append("CTA报告：检查所见")
    return df[cols]


def _scan_stroke_dirs() -> dict[str, str]:
    mapping: dict[str, str] = {}
    if not STROKE_ROOT.exists():
        return mapping
    for p in STROKE_ROOT.iterdir():
        if not p.is_dir():
            continue
        mapping[p.name.upper()] = p.name
    return mapping


CASES_DF = _load_cases()
DIR_MAP = _scan_stroke_dirs()
LABELS = LabelStore(str(LABELS_PATH))

STROKE_INDEX: dict[str, dict] = {}
for upper_name, real_name in DIR_MAP.items():
    p = STROKE_ROOT / real_name
    cta_files = []
    try:
        for fp in p.iterdir():
            if fp.is_file() and fp.name.upper().startswith("CTA") and fp.name.lower().endswith(".nii.gz"):
                cta_files.append(fp.name)
    except Exception:
        cta_files = []
    cta_files.sort()
    STROKE_INDEX[upper_name] = {"folder": real_name, "cta_files": cta_files}


def _case_dir(barcode: str) -> Path | None:
    key = barcode.strip().upper()
    item = STROKE_INDEX.get(key)
    if item and item.get("folder"):
        return STROKE_ROOT / str(item["folder"])
    return None


def _list_cta_files(case_dir: Path) -> list[str]:
    files = []
    for p in case_dir.iterdir():
        if not p.is_file():
            continue
        n = p.name
        if n.upper().startswith("CTA") and n.lower().endswith(".nii.gz"):
            files.append(n)
    files.sort()
    return files


def create_app() -> Flask:
    frontend_dir = ROOT / "frontend"
    # Flask 3.x may fail to auto-detect instance_path when running as a script in
    # some environments (e.g. __main__.__spec__ is None). Pin it explicitly.
    instance_dir = ROOT / "instance"
    instance_dir.mkdir(parents=True, exist_ok=True)
    app = Flask(
        __name__,
        static_folder=str(frontend_dir),
        static_url_path="/",
        instance_path=str(instance_dir),
    )
    # Avoid confusing stale-assets issues during local/forwarded development.
    app.config["SEND_FILE_MAX_AGE_DEFAULT"] = 0

    @app.after_request
    def _no_cache(resp):
        if request.path in ("/", "/index.html", "/app.js", "/style.css"):
            resp.headers["Cache-Control"] = "no-store"
        return resp

    @app.get("/")
    def index():
        return app.send_static_file("index.html")

    @app.get("/api/meta")
    def meta():
        cats = sorted({c for c in CASES_DF["cta_category"].dropna().astype(str).tolist() if c.strip() != ""})
        return jsonify(
            {
                "total": int(len(CASES_DF)),
                "categories": cats,
                "stroke_root_exists": STROKE_ROOT.exists(),
            }
        )

    @app.get("/api/stats")
    def stats():
        labels = LABELS.all()
        checked_barcodes = {
            str(k)
            for k, v in labels.items()
            if isinstance(v, dict) and bool(v.get("checked", False)) and str(k).strip() != ""
        }

        totals = CASES_DF["cta_category"].value_counts().to_dict()
        df_checked = CASES_DF[CASES_DF["条码号"].isin(checked_barcodes)]
        checked = df_checked["cta_category"].value_counts().to_dict()

        cats = sorted({c for c in CASES_DF["cta_category"].dropna().astype(str).tolist() if c.strip() != ""})
        by_category = []
        for c in cats:
            by_category.append(
                {
                    "cta_category": c,
                    "total": int(totals.get(c, 0) or 0),
                    "checked": int(checked.get(c, 0) or 0),
                }
            )

        return jsonify(
            {
                "total": int(len(CASES_DF)),
                "checked": int(len(df_checked)),
                "by_category": by_category,
            }
        )

    @app.get("/api/cases")
    def cases():
        category = (request.args.get("category") or "").strip()
        barcode_q = (request.args.get("barcode") or "").strip()
        df = CASES_DF
        if category and category.lower() != "all":
            df = df[df["cta_category"] == category]
        if barcode_q:
            bq = barcode_q.lower()
            df = df[df["条码号"].str.lower().str.contains(bq, na=False)]

        labels = LABELS.all()
        out = []
        for _, r in df.iterrows():
            barcode = str(r["条码号"])
            idx = STROKE_INDEX.get(barcode.upper())
            folder = idx.get("folder") if idx else None
            cta_files = idx.get("cta_files") if idx else []
            has_cta = bool(cta_files)
            label_obj = labels.get(barcode)
            checked = bool(label_obj.get("checked", False)) if isinstance(label_obj, dict) else False
            out.append(
                {
                    "barcode": barcode,
                    "cta_category": str(r["cta_category"] or ""),
                    "folder": folder,
                    "has_cta": has_cta,
                    "checked": checked,
                }
            )
        return jsonify({"items": out})

    @app.get("/api/case/<barcode>")
    def case_detail(barcode: str):
        barcode = barcode.strip()
        if not barcode:
            return jsonify({"error": "barcode required"}), 400
        row = CASES_DF[CASES_DF["条码号"].str.upper() == barcode.upper()]
        category = str(row.iloc[0]["cta_category"]) if len(row) else ""
        cta_conclusion = str(row.iloc[0].get("CTA检查结论", "")) if len(row) else ""
        cta_findings = str(row.iloc[0].get("CTA报告：检查所见", "")) if len(row) else ""

        idx = STROKE_INDEX.get(barcode.upper())
        folder = idx.get("folder") if idx else None
        cta_files = list(idx.get("cta_files") or []) if idx else []
        default_file = cta_files[0] if cta_files else None
        vol_info = None
        if default_file and folder:
            try:
                vol_info = get_volume_info(str(STROKE_ROOT / folder / default_file))
            except Exception:
                vol_info = None

        label = LABELS.get(barcode)
        return jsonify(
            {
                "barcode": barcode,
                "cta_category": category,
                "cta_conclusion": cta_conclusion,
                "cta_findings": cta_findings,
                "folder": folder,
                "cta_files": cta_files,
                "default_file": default_file,
                "volume_info": vol_info,
                "checked": label.checked if label else False,
                "updated_at": label.updated_at if label else "",
            }
        )

    @app.get("/api/case/<barcode>/volume_info")
    def volume_info(barcode: str):
        barcode = barcode.strip()
        case_dir = _case_dir(barcode)
        if not case_dir or not case_dir.exists():
            return jsonify({"error": "case folder not found"}), 404

        file = (request.args.get("file") or "").strip()
        if not file:
            return jsonify({"error": "file required"}), 400
        if "/" in file or "\\" in file:
            return jsonify({"error": "invalid file"}), 400
        path = case_dir / file
        if not path.exists():
            return jsonify({"error": "file not found"}), 404
        try:
            return jsonify(get_volume_info(str(path)))
        except Exception as e:
            return jsonify({"error": str(e)}), 500

    @app.post("/api/case/<barcode>/label")
    def set_label(barcode: str):
        barcode = barcode.strip()
        if not barcode:
            return jsonify({"error": "barcode required"}), 400
        body = request.get_json(silent=True) or {}
        checked = bool(body.get("checked", False))
        rec = LABELS.set(barcode, checked)
        return jsonify({"barcode": barcode, "checked": rec.checked, "updated_at": rec.updated_at})

    @app.get("/api/case/<barcode>/slice")
    def slice_png(barcode: str):
        barcode = barcode.strip()
        case_dir = _case_dir(barcode)
        if not case_dir or not case_dir.exists():
            return jsonify({"error": "case folder not found"}), 404

        file = (request.args.get("file") or "").strip()
        if not file:
            return jsonify({"error": "file required"}), 400
        if "/" in file or "\\" in file:
            return jsonify({"error": "invalid file"}), 400
        if not file.lower().endswith(".nii.gz"):
            return jsonify({"error": "only .nii.gz supported"}), 400
        path = case_dir / file
        if not path.exists():
            return jsonify({"error": "file not found"}), 404

        axis = (request.args.get("axis") or "z").strip().lower()
        if axis not in ("x", "y", "z"):
            axis = "z"

        try:
            index = int(request.args.get("index") or "0")
        except ValueError:
            index = 0

        wc = request.args.get("wc")
        ww = request.args.get("ww")
        window_center = float(wc) if wc not in (None, "") else None
        window_width = float(ww) if ww not in (None, "") else None

        max_q = (request.args.get("max") or "").strip()
        try:
            max_size = int(max_q) if max_q else None
        except ValueError:
            max_size = None
        if max_size is not None and max_size <= 0:
            max_size = None
        # Default: do not downsample slices (preserve clarity).
        # If you want faster preview while dragging, set SLICE_ALLOW_DOWNSAMPLE=1.
        if max_size is not None and not _env_truthy("SLICE_ALLOW_DOWNSAMPLE", "0"):
            max_size = None

        mtime = None
        try:
            mtime = os.path.getmtime(path)
        except Exception:
            mtime = None

        cache_key = (
            str(path),
            mtime,
            axis,
            int(index),
            None if window_center is None else float(window_center),
            None if window_width is None else float(window_width),
            None if max_size is None else int(max_size),
        )

        png = None
        with _SLICE_CACHE_LOCK:
            hit = _SLICE_CACHE.get(cache_key)
            if hit is not None:
                _SLICE_CACHE.move_to_end(cache_key)
                png = hit

        try:
            if png is None:
                png = render_slice_png(
                    str(path),
                    axis=axis,
                    index=index,
                    window_center=window_center,
                    window_width=window_width,
                    max_size=max_size,
                )
                with _SLICE_CACHE_LOCK:
                    _SLICE_CACHE[cache_key] = png
                    _SLICE_CACHE.move_to_end(cache_key)
                    while len(_SLICE_CACHE) > max(0, _SLICE_CACHE_MAX):
                        _SLICE_CACHE.popitem(last=False)
        except Exception as e:
            return jsonify({"error": str(e)}), 500

        # Flask send_file needs a file-like object
        import io

        resp = send_file(io.BytesIO(png), mimetype="image/png", download_name=f"{barcode}_{file}_{axis}_{index}.png")
        # Allow browser caching by querystring (file/axis/index/wc/ww/max) to reduce confirms re-renders.
        resp.headers["Cache-Control"] = "private, max-age=3600"
        return resp

    return app


app = create_app()

if __name__ == "__main__":
    port = int(os.environ.get("PORT", "5008"))
    # Default to non-debug: some environments forbid Werkzeug debugger's use of /dev/shm.
    debug_env = (os.environ.get("DEBUG") or "").strip().lower()
    debug = debug_env in ("1", "true", "yes", "y", "on")
    app.run(host="0.0.0.0", port=port, debug=debug)
