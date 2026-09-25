"""Source notebook: sources + retrieval, grounded Q&A, studio (guides, FAQ,
glossary, timeline, mind map, podcast) and a Socratic tutor.

Public interface (imported by the core server):
- `init_schema(conn)` creates the notebook tables.
- `NOTEBOOK_TOOLS` is the list of `hypatia.tooling.Tool` for the agent catalog.
- `start_worker(services)` / `stop_worker()` run the background indexing/studio thread.
"""

from __future__ import annotations

from .schema import init_schema
from .tools import NOTEBOOK_TOOLS
from .worker import start_worker, stop_worker

__all__ = ["init_schema", "NOTEBOOK_TOOLS", "start_worker", "stop_worker"]
