"""Exact calculator for the local UI, using the same contract as MCP."""

from fastapi import APIRouter, HTTPException

from ..agent_tools import MathBaseConvertArgs, MathComputeArgs, MathCongruenceSystemArgs, MathContinuedFractionArgs, MathIntegerPairArgs, MathInterpolateArgs, MathLinearCongruenceArgs, MathLinearSystemArgs, MathMatrixArgs, MathPolynomialDivisionArgs, MathPolynomialGcdArgs, MathStatisticsArgs, MathValuesArgs
from ..math_tool import compute, continued_fraction, congruence_system, convert_base, descriptive_statistics, integer_pair, interpolate, linear_congruence, linear_system, matrix_calculate, polynomial_division, polynomial_gcd, values

router = APIRouter(prefix="/api/math")


@router.post("/polynomial-gcd")
def polynomial_common_divisor(body: MathPolynomialGcdArgs):
    try:
        return polynomial_gcd(**body.model_dump())
    except ValueError as error:
        raise HTTPException(400, str(error)) from error


@router.post("/polynomial-division")
def divide_polynomials(body: MathPolynomialDivisionArgs):
    try:
        return polynomial_division(**body.model_dump())
    except ValueError as error:
        raise HTTPException(400, str(error)) from error


@router.post("/continued-fraction")
def expand_continued_fraction(body: MathContinuedFractionArgs):
    try:
        return continued_fraction(**body.model_dump())
    except ValueError as error:
        raise HTTPException(400, str(error)) from error


@router.post("/congruence-system")
def solve_congruence_system(body: MathCongruenceSystemArgs):
    try:
        return congruence_system(**body.model_dump())
    except ValueError as error:
        raise HTTPException(400, str(error)) from error


@router.post("/linear-congruence")
def solve_linear_congruence(body: MathLinearCongruenceArgs):
    try:
        return linear_congruence(**body.model_dump())
    except ValueError as error:
        raise HTTPException(400, str(error)) from error


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
