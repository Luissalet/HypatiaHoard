"""Exact calculator for the local UI, using the same contract as MCP."""

from fastapi import APIRouter, HTTPException

from ..agent_tools import MathComputeArgs, MathLinearSystemArgs, MathValuesArgs
from ..math_tool import compute, linear_system, values

router = APIRouter(prefix="/api/math")


@router.post("/values")
def evaluate_values(body: MathValuesArgs):
    try:
        return values(**body.model_dump())
    except ValueError as error:
        raise HTTPException(400, str(error)) from error


@router.post("/compute")
def calculate(body: MathComputeArgs):
    try:
        return compute(**body.model_dump())
    except ValueError as error:
        raise HTTPException(400, str(error)) from error


@router.post("/linear-system")
def solve_linear_system(body: MathLinearSystemArgs):
    try:
        return linear_system(**body.model_dump())
    except ValueError as error:
        raise HTTPException(400, str(error)) from error
