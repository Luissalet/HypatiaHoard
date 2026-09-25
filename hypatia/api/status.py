"""Health (the family contract) and model status for the PWA."""

from __future__ import annotations

from fastapi import APIRouter, Request

from .. import __version__, ai
from ..hoard_link import family
from .deps import services

router = APIRouter(prefix="/api")


@router.get("/health")
def health(request: Request):
    return {"service": "hypatia-hoard", "version": __version__,
            "dataDirConfigured": request.app.state.config.data_dir_configured, "hoard_link": family.health_block()}


@router.get("/status")
def status(request: Request):
    svc = services(request)
    try:
        rev = svc.store.current_rev()
    except Exception:  # noqa: BLE001 - status never fails
        rev = None
    return {"service": "hypatia-hoard", "version": __version__, "rev": rev, "models": ai.capabilities(svc)}
