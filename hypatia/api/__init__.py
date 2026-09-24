"""API routers."""

from .agent import router as agent_router
from .cards import router as cards_router
from .decks import router as decks_router
from .pwa import router as pwa_router
from .review import router as review_router
from .search import router as search_router
from .stats import router as stats_router
from .status import router as status_router
from .suggest import router as suggest_router

ROUTERS = [status_router, decks_router, cards_router, review_router, stats_router, search_router, pwa_router,
           suggest_router, agent_router]
