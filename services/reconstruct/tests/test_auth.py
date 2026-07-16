"""T36 — bearer auth on POST /reconstruct and DELETE when RECONSTRUCT_API_KEY is set."""

from __future__ import annotations

import asyncio

import pytest

pytest.importorskip("fastapi")
import httpx
from httpx import ASGITransport

from app.main import app, store

KEY = "recon-test-secret"


def _client() -> httpx.AsyncClient:
    return httpx.AsyncClient(transport=ASGITransport(app=app), base_url="http://t")


def test_reconstruct_rejects_missing_and_wrong_bearer_when_key_set(monkeypatch):
    monkeypatch.setenv("RECONSTRUCT_API_KEY", KEY)

    async def run():
        async with _client() as c:
            before = set(store._jobs)
            body = {"glb_base64": "AAAA", "method": "faceted"}
            r = await c.post("/reconstruct", json=body)
            assert r.status_code == 401
            r = await c.post("/reconstruct", json=body, headers={"Authorization": "Bearer wrong"})
            assert r.status_code == 401
            assert set(store._jobs) == before

    asyncio.run(run())


def test_delete_rejects_missing_bearer_when_key_set(monkeypatch):
    monkeypatch.setenv("RECONSTRUCT_API_KEY", KEY)

    async def run():
        async with _client() as c:
            r = await c.delete("/jobs/no-such")
            assert r.status_code == 401

    asyncio.run(run())


def test_open_when_key_unset(monkeypatch):
    monkeypatch.delenv("RECONSTRUCT_API_KEY", raising=False)

    async def run():
        async with _client() as c:
            # Invalid GLB still 400, but not 401 — proves auth is open.
            r = await c.post("/reconstruct", json={"glb_base64": "", "method": "faceted"})
            assert r.status_code != 401

    asyncio.run(run())
