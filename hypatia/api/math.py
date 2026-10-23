"""Exact calculator for the local UI, using the same contract as MCP."""

from fastapi import APIRouter, HTTPException

from ..agent_tools import MathBaseConvertArgs, MathComputeArgs, MathIntegerPairArgs, MathInterpolateArgs, MathLinearSystemArgs, MathMatrixArgs, MathStatisticsArgs, MathValuesArgs
from ..math_tool import compute, convert_base, descriptive_statistics, integer_pair, interpolate, linear_system, matrix_calculate, values

router = APIRouter(prefix="/api/math")


@router.post("/integer-pair")
def calculate_integer_pair(body: MathIntegerPairArgs):
    try:
        return integer_pair(**body.model_dump())
    except ValueError as error:
        raise HTTPException(400, str(error)) from error


@router.post("/statistics")
def calculate_statistics(body: MathStatisticsArgs):
    try:
        return descriptive_statistics(**body.model_dump())
    except ValueError as error:
        raise HTTPException(400, str(error)) from error


@router.post("/matrix")
def calculate_matrix(body: MathMatrixArgs):
    try:
        return matrix_calculate(**body.model_dump())
    except ValueError as error:
        raise HTTPException(400, str(error)) from error


@router.post("/base-convert")
def convert_integer_base(body: MathBaseConvertArgs):
    try:
        return convert_base(**body.model_dump())
    except ValueError as error:
        raise HTTPException(400, str(error)) from error


@router.post("/interpolate")
def interpolate_points(body: MathInterpolateArgs):
    try:
        return interpolate(**body.model_dump())
    except ValueError as error:
        raise HTTPException(400, str(error)) from error


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
