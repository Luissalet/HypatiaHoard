"""Exact calculator for the local UI, using the same contract as MCP."""

from fastapi import APIRouter, HTTPException

from ..agent_tools import MathComputeArgs
from ..math_tool import compute

router = APIRouter(prefix="/api/math")


@router.post("/compute")
def calculate(body: MathComputeArgs):
    try:
        return compute(**body.model_dump())
    except ValueError as error:
        raise HTTPException(400, str(error)) from error
