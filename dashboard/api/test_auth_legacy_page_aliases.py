from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

import auth  # noqa: E402


def test_legacy_paths_alias_to_current_pages() -> None:
    assert '/dashboard' not in auth.PAGE_LABELS
    assert '/wip-generator' not in auth.PAGE_LABELS
    assert auth.LEGACY_PAGE_ALIASES['/dashboard'] == '/'
    assert auth.LEGACY_PAGE_ALIASES['/wip-generator'] == '/generator'
    assert auth._sanitize_pages(['/dashboard', '/', '/wip-generator', '/pile-control', '/generator']) == ['/', '/generator', '/pile']


def test_full_user_pages_expose_only_current_pages() -> None:
    pages = auth._pages_for_group('full_user_pages')
    assert '/' in pages
    assert '/generator' in pages
    assert '/dashboard' not in pages
    assert '/wip-generator' not in pages


def test_auth_page_labels_match_current_navigation_labels() -> None:
    assert auth.PAGE_LABELS['/'] == 'Дашборд'
    assert auth.PAGE_LABELS['/zem-polotno'] == 'МСтрой'
    assert auth.PAGE_LABELS['/structural-schemes'] == 'Структурные схемы'
    assert auth.PAGE_LABELS['/personnel-accommodation'] == 'Размещение персонала'
    assert auth.PAGE_LABELS['/section-rating'] == 'Рейтинг инженеров'
    assert '/dashboard' not in auth.VIEW_REPORT_PATHS
    assert '/zem-polotno' in auth.VIEW_REPORT_PATHS
    assert '/structural-schemes' in auth.VIEW_REPORT_PATHS
    assert '/personnel-accommodation' in auth.VIEW_REPORT_PATHS
    assert '/section-rating' in auth.VIEW_REPORT_PATHS


def test_managed_users_use_db_payload_as_primary_store(monkeypatch, tmp_path) -> None:
    store = {}
    monkeypatch.setattr(auth, "AUTH_MANAGED_USERS_PATH", tmp_path / "auth_managed_users.json")
    monkeypatch.setattr(auth, "_load_auth_setting_payload", lambda key: store.get(key))

    def save_payload(key, payload, updated_by="auth"):
        store[key] = payload
        return True

    monkeypatch.setattr(auth, "_save_auth_setting_payload", save_payload)

    users = [{"username": "new.user", "password": "Pw123456", "role": "user"}]
    auth._save_managed_users(users)

    assert store[auth.AUTH_MANAGED_USERS_SETTING_KEY] == users
    assert auth._load_managed_users() == users


def test_constant_time_password_compare_accepts_unicode_text() -> None:
    assert auth._constant_time_text_equal("пароль", "пароль")
    assert not auth._constant_time_text_equal("пароль", "password")


def test_access_overrides_use_db_payload_as_primary_store(monkeypatch, tmp_path) -> None:
    store = {}
    monkeypatch.setattr(auth, "AUTH_ACCESS_OVERRIDES_PATH", tmp_path / "auth_access_overrides.json")
    monkeypatch.setattr(auth, "_load_auth_setting_payload", lambda key: store.get(key))

    def save_payload(key, payload, updated_by="auth"):
        store[key] = payload
        return True

    monkeypatch.setattr(auth, "_save_auth_setting_payload", save_payload)

    overrides = {"new.user": {"role": "user", "pages": ["/dashboard"], "permissions": ["reports:input"]}}
    auth._save_access_overrides(overrides)

    assert store[auth.AUTH_ACCESS_OVERRIDES_SETTING_KEY] == overrides
    assert auth._load_access_overrides() == overrides
