"""Small exact-math calculator for the assistant, independent of study data."""

from __future__ import annotations

import ast
from decimal import Decimal, InvalidOperation
from fractions import Fraction
import re

import sympy as sp


FUNCTIONS = {"sqrt": sp.sqrt, "sin": sp.sin, "cos": sp.cos, "exp": sp.exp, "log": sp.log}
CONSTANTS = {"pi": sp.pi, "E": sp.E}


def parse_expression(source: str, variable: str) -> sp.Expr:
    source = source.strip()
    if not source or len(source) > 200:
        raise ValueError("Expression must have 1-200 characters.")
    try:
        tree = ast.parse(source, mode="eval")
    except SyntaxError as error:
        raise ValueError("Use arithmetic syntax with ** for powers.") from error
    if sum(1 for _ in ast.walk(tree)) > 60:
        raise ValueError("Expression is too complex.")
    symbol = sp.Symbol(variable)

    def build(node: ast.AST, depth: int = 0) -> sp.Expr:
        if depth > 20:
            raise ValueError("Expression is too deeply nested.")
        if isinstance(node, ast.Constant) and type(node.value) in (int, float):
            if abs(node.value) > 1_000_000:
                raise ValueError("Number is too large.")
            if type(node.value) is float:
                # AST floats have already rounded the user's digits. Read the
                # original literal instead; never reinterpret code as an expression.
                literal = ast.get_source_segment(source, node).replace("_", "")
                exponent = re.search(r"[eE]([+-]?\d+)$", literal)
                if exponent and abs(int(exponent[1])) > 100:
                    raise ValueError("Decimal exponent must be between -100 and 100.")
                return sp.Rational(literal)
            return sp.Rational(str(node.value))
        if isinstance(node, ast.Name):
            if node.id == variable:
                return symbol
            if node.id in CONSTANTS:
                return CONSTANTS[node.id]
        if isinstance(node, ast.UnaryOp) and isinstance(node.op, (ast.UAdd, ast.USub)):
            value = build(node.operand, depth + 1)
            return value if isinstance(node.op, ast.UAdd) else -value
        if isinstance(node, ast.BinOp):
            left, right = build(node.left, depth + 1), build(node.right, depth + 1)
            if isinstance(node.op, ast.Add): return left + right
            if isinstance(node.op, ast.Sub): return left - right
            if isinstance(node.op, ast.Mult): return left * right
            if isinstance(node.op, ast.Div): return left / right
            if isinstance(node.op, ast.Pow) and right.is_Integer and abs(right) <= 8:
                return left ** right
        if isinstance(node, ast.Call) and isinstance(node.func, ast.Name) and node.func.id in FUNCTIONS and not node.keywords and len(node.args) == 1:
            return FUNCTIONS[node.func.id](build(node.args[0], depth + 1))
        raise ValueError("Only arithmetic, one variable and sqrt/sin/cos/exp/log are supported.")

    expression = build(tree.body)
    if sp.count_ops(expression) > 100 or expression.has(sp.zoo, sp.nan) or expression.is_finite is False:
        raise ValueError("Expression is undefined or too complex.")
    return expression


def compute(operation: str, expression: str, variable: str = "x") -> dict:
    if variable not in ("x", "y", "t"):
        raise ValueError("Variable must be x, y or t.")
    symbol = sp.Symbol(variable)
    if operation == "solve":
        parts = expression.split("=")
        if len(parts) > 2:
            raise ValueError("Use one equation only.")
        left = parse_expression(parts[0], variable)
        right = parse_expression(parts[1], variable) if len(parts) == 2 else sp.Integer(0)
        try:
            polynomial = sp.Poly(left - right, symbol)
        except sp.PolynomialError as error:
            raise ValueError("Solving supports polynomial equations only.") from error
        if polynomial.is_zero:
            return {"operation": operation, "expression": expression, "variable": variable,
                    "all_values": True, "solutions": []}
        if polynomial.degree() > 4:
            raise ValueError("Solving supports polynomials up to degree 4.")
        roots = sp.solve(polynomial.as_expr(), symbol)
        return {"operation": operation, "expression": expression, "variable": variable,
                "solutions": [{"exact": str(root), "approx": str(sp.N(root, 12)), "latex": sp.latex(root)} for root in roots]}
    expr = parse_expression(expression, variable)
    if operation == "evaluate":
        if expr.has(symbol):
            raise ValueError("Evaluation needs an expression without the variable.")
        result = sp.simplify(expr)
    elif operation == "differentiate":
        result = sp.diff(expr, symbol)
    else:
        raise ValueError("Operation must be evaluate, solve or differentiate.")
    return {"operation": operation, "expression": expression, "variable": variable,
            "exact": str(result), "approx": str(sp.N(result, 12)) if not result.has(symbol) else None,
            "latex": sp.latex(result)}


def _rational_literal(value: str) -> sp.Rational:
    """A decimal, integer or integer fraction, preserving the written digits."""
    if not isinstance(value, str) or not 1 <= len(value.strip()) <= 100:
        raise ValueError("Coefficients and constants must be number strings of 1-100 characters.")
    text = value.strip()
    try:
        if "/" in text:
            if not re.fullmatch(r"[+-]?\d+\s*/\s*\d+", text):
                raise ValueError("Use integer fractions such as -1/3.")
            number = Fraction(text)
        else:
            decimal = Decimal(text)
            if not decimal.is_finite() or abs(decimal.as_tuple().exponent) > 100:
                raise ValueError("Use finite decimals with exponent between -100 and 100.")
            number = Fraction(decimal)
    except (InvalidOperation, ZeroDivisionError) as error:
        raise ValueError("Use decimal numbers or integer fractions; denominator cannot be zero.") from error
    return sp.Rational(number.numerator, number.denominator)


def linear_system(coefficients: list[list[str]], constants: list[str], variables: list[str]) -> dict:
    """Solve A*x=b over exact rationals, exposing a checkable row reduction.

    Rectangular and rank-deficient systems are supported. Free variables keep
    their original names, so no generated parameter can collide with a name.
    """
    if not isinstance(variables, list) or not 1 <= len(variables) <= 8 or any(
        not isinstance(v, str) or not re.fullmatch(r"[a-zA-Z][a-zA-Z0-9_]{0,19}", v) for v in variables
    ) or len(set(variables)) != len(variables):
        raise ValueError("Use 1-8 distinct variable names, starting with a letter (max 20 characters).")
    if not isinstance(coefficients, list) or not 1 <= len(coefficients) <= 12 or any(
        not isinstance(row, list) or len(row) != len(variables) for row in coefficients
    ) or not isinstance(constants, list) or len(constants) != len(coefficients):
        raise ValueError("Use 1-12 rows; each row must match the variables and have one constant.")
    matrix = sp.Matrix([[_rational_literal(v) for v in row] for row in coefficients])
    rhs = sp.Matrix([_rational_literal(v) for v in constants])
    reduced, pivots = matrix.row_join(rhs).rref()
    n = len(variables)
    coefficient_pivots = [p for p in pivots if p < n]
    rank = len(coefficient_pivots)
    consistent = n not in pivots
    free = [i for i in range(n) if i not in coefficient_pivots] if consistent else []
    out = {"variables": variables, "coefficients_exact": [[str(v) for v in row] for row in matrix.tolist()],
           "constants_exact": [str(v) for v in rhs], "rank": rank, "augmented_rank": len(pivots),
           "classification": "inconsistent" if not consistent else "unique" if rank == n else "infinite",
           "rref_augmented": [[str(v) for v in row] for row in reduced.tolist()],
           "pivot_variables": [variables[i] for i in coefficient_pivots],
           "free_variables": [variables[i] for i in free], "solutions": {}, "residuals_exact": None,
           "verified": None}
    if consistent:
        symbols = [sp.Symbol(v) for v in variables]
        solution = list(symbols)
        for row, pivot in enumerate(coefficient_pivots):
            solution[pivot] = reduced[row, n] - sum(reduced[row, i] * symbols[i] for i in free)
        residuals = matrix * sp.Matrix(solution) - rhs
        out["solutions"] = {name: {"exact": str(value), "approx": str(sp.N(value, 12)) if not value.free_symbols else None,
                                    "latex": sp.latex(value)} for name, value in zip(variables, solution)}
        out["residuals_exact"] = [str(sp.simplify(v)) for v in residuals]
        out["verified"] = all(v == "0" for v in out["residuals_exact"])
    return out
