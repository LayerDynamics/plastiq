"""T36 — bearer auth on POST /capture, /complete, DELETE when CAPTURE_API_KEY is set."""

from __future__ import annotations

import asyncio

import pytest

pytest.importorskip("fastapi")
import httpx
from httpx import ASGITransport

from app.main import app, store

KEY = "capture-test-secret"


def _client() -> httpx.AsyncClient:
    return httpx.AsyncClient(transport=ASGITransport(app=app), base_url="http://t")


def test_capture_rejects_missing_bearer_when_key_set(monkeypatch):
    monkeypatch.setenv("CAPTURE_API_KEY", KEY)

    async def run():
        async with _client() as c:
            before = set(store._jobs)
            body = {
                "points": [[0.0, 0.0, 1.0]] * 16,
                "normals": [[0.0, 0.0, 1.0]] * 16,
            }
            r = await c.post("/capture", json=body)
            assert r.status_code == 401
            r = await c.post("/capture", json=body, headers={"Authorization": "Bearer wrong"})
            assert r.status_code == 401
            assert set(store._jobs) == before

    asyncio.run(run())


def test_complete_rejects_missing_bearer_when_key_set(monkeypatch):
    monkeypatch.setenv("CAPTURE_API_KEY", KEY)

    async def run():
        async with _client() as c:
            body = {"points": [[0.0, 0.0, 1.0]] * 16}
            r = await c.post("/complete", json=body)
            assert r.status_code == 401

    asyncio.run(run())


def test_open_when_key_unset(monkeypatch):
    monkeypatch.delenv("CAPTURE_API_KEY", raising=False)

    async def run():
        async with _client() as c:
            r = await c.get("/health")
            assert r.status_code == 200
            assert r.json()["status"] == "ok"

    asyncio.run(run())
