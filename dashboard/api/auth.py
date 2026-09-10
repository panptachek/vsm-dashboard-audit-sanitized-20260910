"""Small env-backed auth layer for the dashboard."""
from __future__ import annotations

import base64
import hashlib
import hmac
import json
import os
import re
import secrets
import string
import time

import psycopg2
from pathlib import Path
from typing import Any, Literal

from fastapi import APIRouter, Depends, Header, HTTPException, Request
from pydantic import BaseModel, Field


router = APIRouter(prefix="/api/auth", tags=["auth"])

TOKEN_TTL_SECONDS = int(os.getenv("VSM_AUTH_TOKEN_TTL_SECONDS", str(14 * 24 * 60 * 60)))
AUTH_SECRET = os.getenv("VSM_AUTH_SECRET") or os.getenv("SECRET_KEY")
LOGIN_MAX_FAILURES = int(os.getenv("VSM_AUTH_MAX_FAILURES", "10"))
LOGIN_WINDOW_SECONDS = int(os.getenv("VSM_AUTH_WINDOW_SECONDS", "300"))
LOGIN_LOCK_SECONDS = int(os.getenv("VSM_AUTH_LOCK_SECONDS", "900"))
_LOGIN_FAILURES: dict[str, tuple[int, int, int]] = {}
AUTH_ACCESS_OVERRIDES_PATH = Path(os.getenv("VSM_AUTH_ACCESS_OVERRIDES_PATH") or "/opt/vsm/ops/report_pipeline/report_cache/xlsx/auth_access_overrides.json")
AUTH_MANAGED_USERS_PATH = Path(os.getenv("VSM_AUTH_MANAGED_USERS_PATH") or str(AUTH_ACCESS_OVERRIDES_PATH.parent / "auth_managed_users.json"))
AUTH_DB_SETTINGS_ENABLED = (os.getenv("VSM_AUTH_DB_SETTINGS", "1").strip().lower() not in {"0", "false", "no", "off"})
AUTH_MANAGED_USERS_SETTING_KEY = "auth.managed_users.v1"
AUTH_ACCESS_OVERRIDES_SETTING_KEY = "auth.access_overrides.v1"
_AUTH_SETTINGS_SCHEMA_READY = False
USERNAME_RE = re.compile(r"^[A-Za-z0-9_.-]{3,64}$")
PASSWORD_ALPHABET = string.ascii_letters + string.digits


class LoginBody(BaseModel):
    username: str
    password: str


class AuthUser(BaseModel):
    username: str
    role: Literal["admin", "user"]
    access_group: str | None = None
    access_group_label: str | None = None
    pages: list[str] = Field(default_factory=list)
    permissions: list[str] = Field(default_factory=list)


class UserAccessPatchBody(BaseModel):
    role: Literal["admin", "user"] | None = None
    pages: list[str] | None = None
    permissions: list[str] | None = None


class UserAccessCreateBody(UserAccessPatchBody):
    username: str


FULL_USER_PAGE_USERNAMES = {
    "fdeputy",
    "ceo",
    "rp1",
    "rp2",
    "rp3",
    "rp4",
    "rp5",
    "rp6",
    "rp7",
    "rp8",
}

PILE_CONTROL_USERNAMES = {
    "isso",
    "rp_isso",
    "isso_uch1",
    "isso_uch2",
    "isso_uch3",
    "isso_uch4",
    "isso_uch5",
    "isso_uch6",
    "isso_uch7",
    "isso_uch8",
}

PILE_REPORT_INPUT_USERNAMES = {
    "uchastok1",
    "uchastok2",
    "uchastok3",
    "uchastok4",
    "uchastok5",
    "uchastok6",
    "uchastok7",
    "uchastok8",
}

REPORT_INPUT_VIEW_USERNAMES = {"user"}

ACCESS_GROUP_LABELS = {
    "admin_full": "Администратор: полный доступ",
    "full_user_pages": "Все страницы + расширенные права",
    "pile_control": "Контроль свай + ввод свай",
    "pile_report_input": "Ввод свай + просмотр",
    "report_input_view": "Просмотр + ввод отчетов",
    "default_user": "Просмотр + ввод отчетов",
}

PAGE_LABELS = {
    "/": "Дашборд",
    "/analytics": "Аналитика",
    "/section-rating": "Рейтинг инженеров",
    "/reinforcement": "Участки усиления",
    "/zem-polotno": "МСтрой",
    "/structural-schemes": "Структурные схемы",
    "/pile": "Контроль свай",
    "/pilereports": "Ввод свай",
    "/map": "Карта трассы",
    "/mechanization": "Механизация",
    "/personnel-accommodation": "Размещение персонала",
    "/reports": "Отчеты",
    "/statements": "Ведомости",
    "/generator": "Генератор",
    "/database": "База данных",
    "/metabase": "Metabase",
    "/settings": "Настройки",
}

LEGACY_PAGE_ALIASES = {
    "/dashboard": "/",
    "/pile-control": "/pile",
    "/wip-generator": "/generator",
}

FULL_PAGE_PATHS = set(PAGE_LABELS.keys())
VIEW_REPORT_PATHS = {"/", "/map", "/analytics", "/section-rating", "/mechanization", "/personnel-accommodation", "/reinforcement", "/zem-polotno", "/structural-schemes", "/reports"}
KNOWN_PERMISSIONS = ["settings:write", "reports:review", "reports:edit", "reports:input", "pile:control", "pile:input", "statements:project:write"]
KNOWN_PERMISSION_SET = set(KNOWN_PERMISSIONS)


def _extra_user_pairs() -> list[tuple[str, str, str]]:
    raw = os.getenv("VSM_EXTRA_USERS_JSON") or "[]"
    try:
        items = json.loads(raw)
    except json.JSONDecodeError as exc:
        raise HTTPException(500, "Auth env не настроен: VSM_EXTRA_USERS_JSON содержит невалидный JSON") from exc
    if not isinstance(items, list):
        raise HTTPException(500, "Auth env не настроен: VSM_EXTRA_USERS_JSON должен быть JSON-массивом")

    pairs: list[tuple[str, str, str]] = []
    for item in items:
        if not isinstance(item, dict):
            continue
        username = str(item.get("username") or "").strip()
        password = str(item.get("password") or "")
        role = str(item.get("role") or "user").strip()
        if role not in ("admin", "user"):
            raise HTTPException(500, f"Auth env не настроен: неверная роль для {username or 'extra user'}")
        if username and password:
            pairs.append((username, password, role))
    return pairs


def _auth_db_config() -> dict[str, Any]:
    return {
        "dbname": os.getenv("DB_NAME", "works_db_v2"),
        "user": os.getenv("DB_USER", "works_user"),
        "password": os.getenv("DB_PASSWORD", "changeme"),
        "host": os.getenv("DB_HOST", "127.0.0.1"),
        "port": int(os.getenv("DB_PORT", "5433")),
    }


def _auth_db_conn():
    return psycopg2.connect(**_auth_db_config())


def _ensure_auth_settings_schema() -> None:
    global _AUTH_SETTINGS_SCHEMA_READY
    if _AUTH_SETTINGS_SCHEMA_READY or not AUTH_DB_SETTINGS_ENABLED:
        return
    conn = _auth_db_conn()
    try:
        with conn:
            with conn.cursor() as cur:
                cur.execute(
                    """
                    CREATE TABLE IF NOT EXISTS dashboard_settings (
                      key text PRIMARY KEY,
                      payload jsonb NOT NULL,
                      updated_by text,
                      updated_at timestamptz NOT NULL DEFAULT now()
                    )
                    """
                )
        _AUTH_SETTINGS_SCHEMA_READY = True
    finally:
        conn.close()


def _load_auth_setting_payload(key: str) -> Any | None:
    if not AUTH_DB_SETTINGS_ENABLED:
        return None
    try:
        _ensure_auth_settings_schema()
        conn = _auth_db_conn()
        try:
            with conn.cursor() as cur:
                cur.execute("SELECT payload FROM dashboard_settings WHERE key = %s", (key,))
                row = cur.fetchone()
        finally:
            conn.close()
    except Exception:
        return None
    if not row:
        return None
    payload = row[0]
    if isinstance(payload, str):
        try:
            return json.loads(payload)
        except json.JSONDecodeError:
            return None
    return payload


def _save_auth_setting_payload(key: str, payload: Any, updated_by: str = "auth") -> bool:
    if not AUTH_DB_SETTINGS_ENABLED:
        return False
    try:
        _ensure_auth_settings_schema()
        payload_json = json.dumps(payload, ensure_ascii=False)
        conn = _auth_db_conn()
        try:
            with conn:
                with conn.cursor() as cur:
                    cur.execute(
                        """
                        INSERT INTO dashboard_settings(key, payload, updated_by, updated_at)
                        VALUES (%s, %s::jsonb, %s, now())
                        ON CONFLICT (key) DO UPDATE
                        SET payload = EXCLUDED.payload,
                            updated_by = EXCLUDED.updated_by,
                            updated_at = now()
                        """,
                        (key, payload_json, updated_by),
                    )
        finally:
            conn.close()
        return True
    except Exception:
        return False


def _load_json_file(path: Path, fallback: Any) -> Any:
    try:
        if not path.exists():
            return fallback
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return fallback


def _save_json_file(path: Path, payload: Any) -> bool:
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp = path.with_suffix(path.suffix + ".tmp")
        tmp.write_text(json.dumps(payload, ensure_ascii=False, indent=2, sort_keys=True), encoding="utf-8")
        tmp.replace(path)
        return True
    except Exception:
        return False


def _valid_managed_users(raw: Any) -> list[dict[str, Any]]:
    if not isinstance(raw, list):
        return []
    return [item for item in raw if isinstance(item, dict)]


def _load_managed_users_file() -> list[dict[str, Any]]:
    return _valid_managed_users(_load_json_file(AUTH_MANAGED_USERS_PATH, []))


def _load_managed_users() -> list[dict[str, Any]]:
    db_items = _valid_managed_users(_load_auth_setting_payload(AUTH_MANAGED_USERS_SETTING_KEY))
    file_items = _load_managed_users_file()
    by_username: dict[str, dict[str, Any]] = {}
    for item in file_items + db_items:
        username = str(item.get("username") or "").strip()
        if username:
            by_username[username] = item
    return list(by_username.values())


def _save_managed_users(items: list[dict[str, Any]]) -> None:
    payload = _valid_managed_users(items)
    db_saved = _save_auth_setting_payload(AUTH_MANAGED_USERS_SETTING_KEY, payload, updated_by="auth:managed_users")
    file_saved = _save_json_file(AUTH_MANAGED_USERS_PATH, payload)
    if not db_saved and not file_saved:
        raise HTTPException(500, "Не удалось сохранить учетные записи")


def _managed_user_entries() -> list[dict[str, str]]:
    entries: list[dict[str, str]] = []
    for item in _load_managed_users():
        username = str(item.get("username") or "").strip()
        password = str(item.get("password") or "")
        role = str(item.get("role") or "user").strip()
        if username and password and role in ("admin", "user"):
            entries.append({"username": username, "password": password, "role": role, "source": "settings:managed_users"})
    return entries


def _generate_password(length: int = 24) -> str:
    while True:
        password = "".join(secrets.choice(PASSWORD_ALPHABET) for _ in range(length))
        if (
            any(ch.islower() for ch in password)
            and any(ch.isupper() for ch in password)
            and any(ch.isdigit() for ch in password)
        ):
            return password


def _constant_time_text_equal(left: object, right: object) -> bool:
    return hmac.compare_digest(
        str(left if left is not None else "").encode("utf-8"),
        str(right if right is not None else "").encode("utf-8"),
    )


def _normalize_new_username(value: str) -> str:
    username = (value or "").strip()
    if not USERNAME_RE.match(username):
        raise HTTPException(400, "Логин должен быть 3-64 символа: латиница, цифры, точка, дефис или подчеркивание")
    return username


def _user_entries() -> list[dict[str, str]]:
    entries = [
        {"username": os.getenv("VSM_ADMIN_USERNAME") or "", "password": os.getenv("VSM_ADMIN_PASSWORD") or "", "role": "admin", "source": "VSM_ADMIN_*"},
        {"username": os.getenv("VSM_USER_USERNAME") or "", "password": os.getenv("VSM_USER_PASSWORD") or "", "role": "user", "source": "VSM_USER_*"},
    ]
    entries.extend(
        {"username": username, "password": password, "role": role, "source": "VSM_EXTRA_USERS_JSON"}
        for username, password, role in _extra_user_pairs()
    )
    entries.extend(_managed_user_entries())
    seen: set[str] = set()
    result: list[dict[str, str]] = []
    for entry in entries:
        username = entry.get("username") or ""
        if not username or not entry.get("password") or username in seen:
            continue
        seen.add(username)
        result.append(entry)
    return result


def _users() -> dict[str, dict[str, str]]:
    return {
        entry["username"]: {"password": entry["password"], "role": entry["role"]}
        for entry in _user_entries()
    }


def _login_key(request: Request, username: str) -> str:
    client = request.headers.get("x-real-ip") or (request.client.host if request.client else "unknown")
    return f"{client}:{username}"


def _check_login_limit(key: str) -> None:
    now = int(time.time())
    count, first_ts, locked_until = _LOGIN_FAILURES.get(key, (0, now, 0))
    if locked_until > now:
        raise HTTPException(429, "Слишком много попыток входа. Попробуйте позже")
    if now - first_ts > LOGIN_WINDOW_SECONDS:
        _LOGIN_FAILURES.pop(key, None)


def _record_login_failure(key: str) -> None:
    now = int(time.time())
    count, first_ts, locked_until = _LOGIN_FAILURES.get(key, (0, now, 0))
    if now - first_ts > LOGIN_WINDOW_SECONDS:
        count, first_ts = 0, now
    count += 1
    if count >= LOGIN_MAX_FAILURES:
        locked_until = now + LOGIN_LOCK_SECONDS
    _LOGIN_FAILURES[key] = (count, first_ts, locked_until)


def _clear_login_failures(key: str) -> None:
    _LOGIN_FAILURES.pop(key, None)


def _b64(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).decode("ascii").rstrip("=")


def _unb64(value: str) -> bytes:
    padding = "=" * (-len(value) % 4)
    return base64.urlsafe_b64decode(value + padding)


def _sign(payload: str) -> str:
    if not AUTH_SECRET:
        raise HTTPException(500, "Auth env не настроен: задайте VSM_AUTH_SECRET")
    return _b64(hmac.new(AUTH_SECRET.encode("utf-8"), payload.encode("utf-8"), hashlib.sha256).digest())


def create_token(user: AuthUser) -> str:
    payload = {
        "username": user.username,
        "role": user.role,
        "exp": int(time.time()) + TOKEN_TTL_SECONDS,
    }
    payload_b64 = _b64(json.dumps(payload, separators=(",", ":"), ensure_ascii=False).encode("utf-8"))
    return f"v1.{payload_b64}.{_sign(payload_b64)}"


def decode_token(token: str) -> AuthUser:
    try:
        version, payload_b64, sig = token.split(".", 2)
    except ValueError as exc:
        raise HTTPException(401, "Требуется вход в систему") from exc
    if version != "v1" or not hmac.compare_digest(sig, _sign(payload_b64)):
        raise HTTPException(401, "Недействительная сессия")
    try:
        payload = json.loads(_unb64(payload_b64).decode("utf-8"))
    except Exception as exc:
        raise HTTPException(401, "Недействительная сессия") from exc
    if int(payload.get("exp") or 0) < int(time.time()):
        raise HTTPException(401, "Сессия истекла")
    role = payload.get("role")
    if role not in ("admin", "user"):
        raise HTTPException(401, "Недействительная роль")
    return _user_with_access(str(payload.get("username") or ""), role)


def current_user(authorization: str | None = Header(default=None)) -> AuthUser:
    if not authorization or not authorization.lower().startswith("bearer "):
        raise HTTPException(401, "Требуется вход в систему")
    return decode_token(authorization.split(" ", 1)[1].strip())


def require_admin(user: AuthUser = Depends(current_user)) -> AuthUser:
    if user.role != "admin":
        raise HTTPException(403, "Действие доступно только администратору")
    return user


def _settings_manager_usernames() -> set[str]:
    raw_extra = os.getenv("VSM_SETTINGS_MANAGER_USERNAMES") or ""
    return {item.strip() for item in raw_extra.split(",") if item.strip()}


def require_settings_manager(user: AuthUser = Depends(current_user)) -> AuthUser:
    if user.role == "admin" or "settings:write" in set(user.permissions or []) or user.username in _settings_manager_usernames():
        return user
    raise HTTPException(403, "Настройки может менять только admin или пользователь с правом изменения настроек")


def require_statements_project_writer(user: AuthUser = Depends(current_user)) -> AuthUser:
    if user.role == "admin" or "statements:project:write" in set(user.permissions or []):
        return user
    raise HTTPException(403, "Проектные данные в ведомостях может менять только пользователь с правом редактирования проектных данных")


def _valid_access_overrides(raw: Any) -> dict[str, dict[str, Any]]:
    if not isinstance(raw, dict):
        return {}
    return {str(username): value for username, value in raw.items() if isinstance(value, dict)}


def _load_access_overrides_file() -> dict[str, dict[str, Any]]:
    return _valid_access_overrides(_load_json_file(AUTH_ACCESS_OVERRIDES_PATH, {}))


def _load_access_overrides() -> dict[str, dict[str, Any]]:
    merged = _load_access_overrides_file()
    merged.update(_valid_access_overrides(_load_auth_setting_payload(AUTH_ACCESS_OVERRIDES_SETTING_KEY)))
    return merged


def _save_access_overrides(data: dict[str, dict[str, Any]]) -> None:
    payload = _valid_access_overrides(data)
    db_saved = _save_auth_setting_payload(AUTH_ACCESS_OVERRIDES_SETTING_KEY, payload, updated_by="auth:access_overrides")
    file_saved = _save_json_file(AUTH_ACCESS_OVERRIDES_PATH, payload)
    if not db_saved and not file_saved:
        raise HTTPException(500, "Не удалось сохранить права учетных записей")


def _access_override(username: str) -> dict[str, Any]:
    return _load_access_overrides().get(username, {})


def _sanitize_pages(value: object) -> list[str] | None:
    if value is None:
        return None
    if not isinstance(value, list):
        return []
    seen: set[str] = set()
    out: list[str] = []
    for item in value:
        path = str(item or "").strip()
        path = LEGACY_PAGE_ALIASES.get(path, path)
        if path in PAGE_LABELS and path not in seen:
            seen.add(path)
            out.append(path)
    return out


def _sanitize_permissions(value: object) -> list[str] | None:
    if value is None:
        return None
    if not isinstance(value, list):
        return []
    seen: set[str] = set()
    out: list[str] = []
    for item in value:
        permission = str(item or "").strip()
        if permission in KNOWN_PERMISSION_SET and permission not in seen:
            seen.add(permission)
            out.append(permission)
    return out


def _effective_role(username: str, role: str) -> Literal["admin", "user"]:
    override_role = _access_override(username).get("role")
    candidate = str(override_role or role or "user")
    return "admin" if candidate == "admin" else "user"


def _default_access_group(username: str, role: str) -> str:
    if role == "admin":
        return "admin_full"
    if username in FULL_USER_PAGE_USERNAMES:
        return "full_user_pages"
    if username in PILE_CONTROL_USERNAMES:
        return "pile_control"
    if username in PILE_REPORT_INPUT_USERNAMES:
        return "pile_report_input"
    if username in REPORT_INPUT_VIEW_USERNAMES:
        return "report_input_view"
    return "default_user"


def _access_group(username: str, role: str) -> str:
    effective_role = _effective_role(username, role)
    override_group = str(_access_override(username).get("access_group") or "")
    if override_group in ACCESS_GROUP_LABELS:
        return override_group
    return _default_access_group(username, effective_role)


def _pages_for_group(group: str) -> list[str]:
    if group in {"admin_full", "full_user_pages"}:
        paths = FULL_PAGE_PATHS
    elif group == "pile_control":
        paths = {"/pile", "/pilereports"}
    elif group == "pile_report_input":
        paths = {*VIEW_REPORT_PATHS, "/pilereports"}
    else:
        paths = VIEW_REPORT_PATHS
    return [path for path in PAGE_LABELS if path in paths]


def _permissions_for_group(group: str) -> list[str]:
    if group == "admin_full":
        return ["settings:write", "reports:review", "reports:edit", "reports:input", "pile:control", "pile:input", "statements:project:write"]
    if group == "full_user_pages":
        return ["settings:write", "reports:edit", "reports:input", "pile:control", "pile:input"]
    if group == "pile_control":
        return ["reports:input", "pile:control", "pile:input"]
    if group == "pile_report_input":
        return ["reports:input", "pile:input"]
    return ["reports:input"]


def _pages_for_role(role: str) -> list[str]:
    paths = FULL_PAGE_PATHS if role == "admin" else VIEW_REPORT_PATHS
    return [path for path in PAGE_LABELS if path in paths]


def _permissions_for_role(role: str) -> list[str]:
    if role == "admin":
        return [permission for permission in KNOWN_PERMISSIONS]
    return ["reports:input"]


def _access_pages(username: str, role: str) -> list[str]:
    override_pages = _sanitize_pages(_access_override(username).get("pages"))
    if override_pages is not None:
        return [path for path in PAGE_LABELS if path in {*override_pages, "/section-rating"}]
    return _pages_for_group(_access_group(username, role))


def _access_permissions(username: str, role: str) -> list[str]:
    override_permissions = _sanitize_permissions(_access_override(username).get("permissions"))
    if override_permissions is not None:
        return override_permissions
    return _permissions_for_group(_access_group(username, role))


def _user_with_access(username: str, role: str) -> AuthUser:
    effective_role = _effective_role(username, role)
    group = _access_group(username, effective_role)
    return AuthUser(
        username=username,
        role=effective_role,
        access_group=group,
        access_group_label=ACCESS_GROUP_LABELS.get(group, group),
        pages=_access_pages(username, effective_role),
        permissions=_access_permissions(username, effective_role),
    )


def _user_access_row(entry: dict[str, str]) -> dict[str, Any]:
    username = entry["username"]
    role = _effective_role(username, entry["role"])
    pages = _access_pages(username, role)
    return {
        "username": username,
        "password": entry["password"],
        "role": role,
        "base_role": entry["role"],
        "source": entry["source"],
        "pages": pages,
        "page_labels": [PAGE_LABELS[path] for path in pages],
        "permissions": _access_permissions(username, role),
        "override": bool(_access_override(username)),
    }


@router.get("/users-access")
def users_access(_admin: AuthUser = Depends(require_admin)):
    return {
        "rows": [
            _user_access_row(entry)
            for entry in sorted(_user_entries(), key=lambda item: (item["role"] != "admin", item["username"]))
        ],
        "page_labels": PAGE_LABELS,
        "known_permissions": KNOWN_PERMISSIONS,
    }


@router.post("/users-access")
def create_user_access(body: UserAccessCreateBody, _admin: AuthUser = Depends(require_admin)):
    username = _normalize_new_username(body.username)
    if username in {entry["username"] for entry in _user_entries()}:
        raise HTTPException(409, "Учетная запись с таким логином уже существует")

    role = body.role or "user"
    pages = _sanitize_pages(body.pages) if body.pages is not None else _pages_for_role(role)
    permissions = _sanitize_permissions(body.permissions) if body.permissions is not None else _permissions_for_role(role)
    password = _generate_password()

    managed_users = _load_managed_users()
    if any(str(item.get("username") or "").strip() == username for item in managed_users):
        raise HTTPException(409, "Учетная запись с таким логином уже существует")
    managed_users.append({
        "username": username,
        "password": password,
        "role": role,
        "created_by": _admin.username,
        "created_at": int(time.time()),
    })
    _save_managed_users(managed_users)

    overrides = _load_access_overrides()
    overrides[username] = {
        "role": role,
        "pages": pages,
        "permissions": permissions,
    }
    _save_access_overrides(overrides)

    entry = {"username": username, "password": password, "role": role, "source": "settings:managed_users"}
    return _user_access_row(entry)


@router.put("/users-access/{username}")
def update_user_access(username: str, body: UserAccessPatchBody, _admin: AuthUser = Depends(require_admin)):
    entries = {entry["username"]: entry for entry in _user_entries()}
    if username not in entries:
        raise HTTPException(404, "Учетная запись не найдена")

    role = body.role or _effective_role(username, entries[username]["role"])
    pages = _sanitize_pages(body.pages) if body.pages is not None else _access_pages(username, role)
    permissions = _sanitize_permissions(body.permissions) if body.permissions is not None else _access_permissions(username, role)

    overrides = _load_access_overrides()
    overrides[username] = {
        "role": role,
        "pages": pages,
        "permissions": permissions,
    }
    _save_access_overrides(overrides)
    return _user_access_row(entries[username])


@router.post("/login")
async def login(body: LoginBody, request: Request):
    if not AUTH_SECRET or not _users():
        raise HTTPException(500, "Auth env не настроен: задайте VSM_AUTH_SECRET и учетные записи")
    username = (body.username or "").strip()
    password = body.password or ""
    login_key = _login_key(request, username)
    _check_login_limit(login_key)
    spec = _users().get(username)
    if not spec or not _constant_time_text_equal(password, spec.get("password")):
        _record_login_failure(login_key)
        raise HTTPException(401, "Неверный логин или пароль")
    _clear_login_failures(login_key)
    user = _user_with_access(username, spec["role"])
    return {"token": create_token(user), "user": user.dict()}


@router.get("/me")
def me(user: AuthUser = Depends(current_user)):
    return {"user": user.dict()}
