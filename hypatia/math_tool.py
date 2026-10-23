"""Small exact-math calculator for the assistant, independent of study data."""

from __future__ import annotations

import ast
from decimal import Decimal, InvalidOperation
from fractions import Fraction
import re
import json
from pathlib import Path
import subprocess
import sys

import sympy as sp


FUNCTIONS = {"sqrt": sp.sqrt, "sin": sp.sin, "cos": sp.cos, "exp": sp.exp, "log": sp.log}
CONSTANTS = {"pi": sp.pi, "E": sp.E}


def parse_expression(source: str, variable: str, *, polynomial: bool = False,
                     binding: sp.Expr | None = None, constant: bool = False) -> sp.Expr:
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
        value = build_node(node, depth)
        # In point evaluation an undefined inner operation must not disappear
        # through cancellation, multiplication by zero or a later power.
        if (binding is not None or constant) and (value.has(sp.zoo, sp.nan) or value.is_finite is False):
            raise ValueError("Expression is undefined at this point.")
        return value

    def build_node(node: ast.AST, depth: int = 0) -> sp.Expr:
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
                if constant:
                    raise ValueError("Points must not contain a variable, even if it cancels.")
                return symbol if binding is None else binding
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
            if isinstance(node.op, ast.Div):
                if polynomial and right.has(sp.Symbol(variable)):
                    raise ValueError("Polynomial operations need constant denominators.")
                return left / right
            if isinstance(node.op, ast.Pow) and right.is_Integer and abs(right) <= 8:
                if polynomial and right < 0 and left.has(sp.Symbol(variable)):
                    raise ValueError("Polynomial operations need nonnegative variable powers.")
                return left ** right
        if isinstance(node, ast.Call) and isinstance(node.func, ast.Name) and node.func.id in FUNCTIONS and not node.keywords and len(node.args) == 1:
            value = build(node.args[0], depth + 1)
            if polynomial and value.has(sp.Symbol(variable)):
                raise ValueError("Polynomial operations do not use functions of the variable.")
            return FUNCTIONS[node.func.id](value)
        raise ValueError("Only arithmetic, one variable and sqrt/sin/cos/exp/log are supported.")

    expression = build(tree.body)
    if sp.count_ops(expression) > 100 or expression.has(sp.zoo, sp.nan) or expression.is_finite is False:
        raise ValueError("Expression is undefined or too complex.")
    return expression


def _point(source: str, variable: str) -> sp.Expr:
    """Real constants only; infinity is allowed at calculus endpoints."""
    if source.strip() in ("oo", "+oo", "-oo"):
        return -sp.oo if source.strip() == "-oo" else sp.oo
    value = parse_expression(source, variable)
    if value.free_symbols or value.is_real is not True:
        raise ValueError("Bounds and limit points must be real constants (or oo/-oo).")
    return value


def _value(result: sp.Expr) -> dict:
    return {"exact": str(result),
            "approx": str(sp.N(result, 12)) if not result.free_symbols and result.is_finite is True and not result.has(sp.AccumBounds) else None,
            "latex": sp.latex(result)}


def values(expression: str, points: list[str], variable: str = "x") -> dict:
    """Evaluate the written AST at ordered finite real points, not a limit."""
    if variable not in ("x", "y", "t"):
        raise ValueError("Variable must be x, y or t.")
    if not isinstance(points, list) or not points or any(not isinstance(p, str) for p in points):
        raise ValueError("Provide a nonempty list of point strings.")
    # Validate the original grammar before binding: e.g. x**x is unsupported
    # even if a particular point would turn the exponent into an integer.
    parse_expression(expression, variable)
    rows = []
    for point in points:
        row = {"point": point}
        try:
            target = parse_expression(point, variable, constant=True)
            if target.is_real is not True or target.is_finite is not True:
                raise ValueError("Points must be finite real constants.")
        except ValueError as error:
            rows.append({**row, "status": "invalid_point", "error": str(error)})
            continue
        row["point_exact"] = str(target)
        try:
            result = parse_expression(expression, variable, binding=target)
            status = "unevaluated" if result.is_finite is not True else "evaluated" if result.is_real is True else "complex"
            rows.append({**row, "status": status, **_value(result)})
        except ValueError as error:
            rows.append({**row, "status": "undefined", "error": str(error)})
    return {"expression": expression, "variable": variable, "points": points, "rows": rows}


def _compute(operation: str, expression: str, variable: str = "x", *,
            lower: str | None = None, upper: str | None = None,
            point: str | None = None, side: str = "both") -> dict:
    if variable not in ("x", "y", "t"):
        raise ValueError("Variable must be x, y or t.")
    if side not in ("both", "left", "right"):
        raise ValueError("Side must be both, left or right.")
    if operation != "integrate" and (lower is not None or upper is not None):
        raise ValueError("Bounds are only used for integration.")
    if operation != "limit" and (point is not None or side != "both"):
        raise ValueError("Point and side are only used for limits.")
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
    expr = parse_expression(expression, variable, polynomial=operation in ("expand", "factor"))
    if operation == "evaluate":
        if expr.has(symbol):
            raise ValueError("Evaluation needs an expression without the variable.")
        result = sp.simplify(expr)
    elif operation in ("expand", "factor"):
        try:
            polynomial = sp.Poly(expr, symbol, domain=sp.QQ)
        except (sp.PolynomialError, sp.polys.polyerrors.CoercionFailed) as error:
            raise ValueError("Developing and factoring need a polynomial with rational coefficients.") from error
        result = sp.expand(polynomial.as_expr()) if operation == "expand" else sp.factor(polynomial.as_expr())
    elif operation == "differentiate":
        result = sp.diff(expr, symbol)
    elif operation == "integrate":
        if (lower is None) != (upper is None):
            raise ValueError("Provide both integration bounds, or omit both for a primitive.")
        bounds = (_point(lower, variable), _point(upper, variable)) if lower is not None else None
        integral = sp.Integral(expr, (symbol, *bounds) if bounds else symbol)
        try:
            result = integral.doit()
        except (NotImplementedError, ValueError):
            result = integral
        status = "unevaluated" if result.has(sp.Integral) else "divergent" if result.has(sp.oo, -sp.oo, sp.zoo, sp.nan, sp.AccumBounds) else "evaluated"
        value = _value(result)
        if status != "evaluated":
            value["approx"] = None
        return {"operation": operation, "expression": expression, "variable": variable,
                "lower": lower, "upper": upper, "status": status,
                "integration_constant": "C" if bounds is None else None,
                **value}
    elif operation == "limit":
        if point is None:
            raise ValueError("Provide a limit point, such as 0, pi, oo or -oo.")
        target = _point(point, variable)

        def at(direction: str) -> sp.Expr:
            limit = sp.Limit(expr, symbol, target, dir=direction)
            try:
                return limit.doit()
            except (NotImplementedError, ValueError):
                return limit

        out = {"operation": operation, "expression": expression, "variable": variable,
               "point": point, "side": side}
        if target.is_infinite:
            result = at("-" if target == sp.oo else "+")
        elif side == "both":
            left, right = at("-"), at("+")
            out.update(left=_value(left), right=_value(right))
            if left.has(sp.Limit) or right.has(sp.Limit):
                return {**out, "status": "unevaluated", "exact": None, "approx": None, "latex": None}
            if left != right or left.has(sp.AccumBounds) or right.has(sp.AccumBounds):
                return {**out, "status": "nonexistent", "exact": None, "approx": None, "latex": None}
            result = left
        else:
            result = at("-" if side == "left" else "+")
        status = "unevaluated" if result.has(sp.Limit) else "nonexistent" if result.has(sp.AccumBounds, sp.zoo, sp.nan) else "infinite" if result.is_infinite else "evaluated"
        value = _value(result)
        if status != "evaluated":
            value["approx"] = None
        return {**out, "status": status, **value}
    else:
        raise ValueError("Operation must be evaluate, expand, factor, solve, differentiate, integrate or limit.")
    return {"operation": operation, "expression": expression, "variable": variable,
            "exact": str(result), "approx": str(sp.N(result, 12)) if not result.has(symbol) else None,
            "latex": sp.latex(result)}


def compute(operation: str, expression: str, variable: str = "x", *,
            lower: str | None = None, upper: str | None = None,
            point: str | None = None, side: str = "both") -> dict:
    arguments = dict(operation=operation, expression=expression, variable=variable,
                     lower=lower, upper=upper, point=point, side=side)
    if operation not in ("integrate", "limit"):
        return _compute(**arguments)
    # Symbolic calculus can fail to finish even on a short formula. A separate
    # process keeps the server responsive and can actually be stopped on Windows.
    try:
        worker = subprocess.run([sys.executable, str(Path(__file__).resolve())],
                                input=json.dumps(arguments), capture_output=True, text=True,
                                timeout=15, creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0), check=True)
    except subprocess.TimeoutExpired as error:
        raise ValueError("Calculation did not finish in 15 seconds. Simplify the expression and try again.") from error
    payload = json.loads(worker.stdout)
    if "error" in payload:
        raise ValueError(payload["error"])
    return payload


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


if __name__ == "__main__":
    try:
        print(json.dumps(_compute(**json.load(sys.stdin))))
    except ValueError as error:
        print(json.dumps({"error": str(error)}))
