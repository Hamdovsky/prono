import asyncio
import os

import pytest
from fastapi import HTTPException


def _load_server(monkeypatch, secret, allow_unauth):
    monkeypatch.setenv('API_SECRET_KEY', secret)
    if allow_unauth:
        monkeypatch.setenv('FASTAPI_ALLOW_UNAUTH', '1')
    else:
        monkeypatch.delenv('FASTAPI_ALLOW_UNAUTH', raising=False)
    import fastapi_server

    return fastapi_server


def _run(coro):
    return asyncio.run(coro)


class TestRequireAuthFailClosed:
    def test_no_secret_no_dev_flag_rejects(self, monkeypatch):
        srv = _load_server(monkeypatch, '', False)
        with pytest.raises(HTTPException) as exc:
            _run(srv.require_auth(None))
        assert exc.value.status_code == 503

    def test_no_secret_with_dev_flag_allows(self, monkeypatch):
        srv = _load_server(monkeypatch, '', True)
        assert _run(srv.require_auth(None)) is None

    def test_secret_missing_header_rejects(self, monkeypatch):
        srv = _load_server(monkeypatch, 's3cret', False)
        with pytest.raises(HTTPException) as exc:
            _run(srv.require_auth(None))
        assert exc.value.status_code == 401

    def test_secret_wrong_token_rejects(self, monkeypatch):
        srv = _load_server(monkeypatch, 's3cret', False)
        with pytest.raises(HTTPException) as exc:
            _run(srv.require_auth('Bearer nope'))
        assert exc.value.status_code == 401

    def test_secret_valid_token_allows(self, monkeypatch):
        srv = _load_server(monkeypatch, 's3cret', False)
        assert _run(srv.require_auth('Bearer s3cret')) is None


class TestOptionalAuthFailClosed:
    def test_predict_public_when_no_secret_and_no_key_anywhere(self, monkeypatch):
        # dev local : FASTAPI_ALLOW_UNAUTH=1 -> /predict reste accessible sans header
        srv = _load_server(monkeypatch, '', True)
        assert _run(srv.optional_auth(None)) is None

    def test_predict_503_when_secret_absent_and_not_dev(self, monkeypatch):
        srv = _load_server(monkeypatch, '', False)
        with pytest.raises(HTTPException) as exc:
            _run(srv.optional_auth(None))
        assert exc.value.status_code == 503

    def test_predict_valid_token_ok(self, monkeypatch):
        srv = _load_server(monkeypatch, 'abc', False)
        assert _run(srv.optional_auth('Bearer abc')) is None

    def test_predict_bad_token_rejects(self, monkeypatch):
        srv = _load_server(monkeypatch, 'abc', False)
        with pytest.raises(HTTPException) as exc:
            _run(srv.optional_auth('Bearer xyz'))
        assert exc.value.status_code == 401
