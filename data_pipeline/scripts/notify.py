"""Notification Telegram (best-effort) pour les alertes du pipeline.

Lecture de TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID dans l'environnement (ou
.env du projet, chargé si python-dotenv est présent). Silencieux si non
configuré : le pipeline ne doit jamais casser à cause des alertes.
"""
from __future__ import annotations

import logging
import os
from pathlib import Path

import requests

log = logging.getLogger(__name__)


def _load_env() -> None:
    try:
        from dotenv import load_dotenv
        load_dotenv(Path(__file__).resolve().parents[1] / ".env")
    except ImportError:
        pass


def send_telegram(text: str, token: str | None = None, chat_id: str | None = None) -> bool:
    """Envoie un message via l'API Telegram. Retourne True si réellement envoyé."""
    token = token or os.environ.get("TELEGRAM_BOT_TOKEN")
    chat_id = chat_id or os.environ.get("TELEGRAM_CHAT_ID")
    if not token or not chat_id:
        return False
    try:
        resp = requests.post(
            f"https://api.telegram.org/bot{token}/sendMessage",
            json={"chat_id": chat_id, "text": text[:4000]},
            timeout=15,
        )
        return resp.ok
    except requests.RequestException as e:
        log.warning("Telegram send failed: %s", e)
        return False


def notify(message: str) -> bool:
    """Envoie une alerte si configurée, sinon no-op."""
    _load_env()
    return send_telegram(message)