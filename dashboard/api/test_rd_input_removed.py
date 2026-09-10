#!/usr/bin/env python3
from __future__ import annotations

from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
RD_ROUTE = "/rd" + "-input"
RD_PAGE = "Rd" + "InputPage"
RD_LABEL = "Ввод" + " РД"
RD_MODULE = "wip" + "_rd_routes"
RD_ROUTER = "wip" + "_rd_router"


def test_backend_does_not_mount_rd_input_router() -> None:
    main_py = (ROOT / "api" / "main.py").read_text(encoding="utf-8")
    assert RD_MODULE not in main_py
    assert RD_ROUTER not in main_py


def test_auth_page_labels_do_not_expose_rd_input() -> None:
    auth_py = (ROOT / "api" / "auth.py").read_text(encoding="utf-8")
    assert f'"{RD_ROUTE}"' not in auth_py
    assert RD_LABEL not in auth_py


def test_frontend_routes_do_not_expose_rd_input() -> None:
    frontend_files = [
        ROOT / "frontend" / "src" / "App.tsx",
        ROOT / "frontend" / "src" / "components" / "Layout.tsx",
        ROOT / "frontend" / "src" / "access.ts",
    ]
    combined = "\n".join(path.read_text(encoding="utf-8") for path in frontend_files)
    assert RD_ROUTE not in combined
    assert RD_PAGE not in combined
    assert RD_LABEL not in combined
