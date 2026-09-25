"""API routers (the notebook router is Agent B's, mounted in main.py when present)."""

from .agent import router as agent_router
from .ai import router as ai_router
from .bank import router as bank_router
from .resources import router as resources_router
from .status import router as status_router
from .study import router as study_router
from .sync import router as sync_router

ROUTERS = [status_router, sync_router, bank_router, study_router, ai_router, agent_router, resources_router]
