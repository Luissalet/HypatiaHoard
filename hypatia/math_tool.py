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


def polynomial_division(dividend: str, divisor: str, variable: str = "x") -> dict:
    """Euclidean division over the rationals, preserving the written inputs."""
    if variable not in ("x", "y", "t"):
        raise ValueError("Variable must be x, y or t.")
    symbol = sp.Symbol(variable)
    polynomials = []
    for name, source in (("dividend", dividend), ("divisor", divisor)):
        try:
            polynomials.append(sp.Poly(parse_expression(source, variable, polynomial=True), symbol, domain=sp.QQ))
        except (sp.PolynomialError, sp.polys.polyerrors.CoercionFailed) as error:
            raise ValueError(f"{name}: use a polynomial with rational coefficients.") from error
    first, second = polynomials
    if second.is_zero:
        raise ValueError("The divisor polynomial cannot be zero.")
    quotient, remainder = first.div(second)
    residual = first - second * quotient - remainder
    def pack(poly):
        return {"exact": str(poly.as_expr()), "latex": sp.latex(poly.as_expr()),
                "degree": None if poly.is_zero else int(poly.degree())}
    return {"dividend": dividend, "divisor": divisor, "variable": variable,
            "dividend_normalized": pack(first), "divisor_normalized": pack(second),
            "quotient": pack(quotient), "remainder": pack(remainder),
            "identity": f"({first.as_expr()}) = ({second.as_expr()}) * ({quotient.as_expr()}) + ({remainder.as_expr()})",
            "residual": str(residual.as_expr()), "exact_division": bool(remainder.is_zero),
            "verified": bool(residual.is_zero and (remainder.is_zero or remainder.degree() < second.degree()))}


def rational_taylor(numerator: str, denominator: str, center: str = "0", order: int = 3,
                    variable: str = "x") -> dict:
    """Taylor polynomial over QQ, with an exact algebraic remainder."""
    if variable not in ("x", "y", "t"):
        raise ValueError("Variable must be x, y or t.")
    if type(order) is not int or not 0 <= order <= 12:
        raise ValueError("Taylor degree must be an integer from 0 to 12.")
    symbol = sp.Symbol(variable)
    polynomials = []
    for name, source in (("numerator", numerator), ("denominator", denominator)):
        try:
            polynomials.append(sp.Poly(parse_expression(source, variable, polynomial=True), symbol, domain=sp.QQ))
        except (sp.PolynomialError, sp.polys.polyerrors.CoercionFailed) as error:
            raise ValueError(f"{name}: use a polynomial with rational coefficients.") from error
    first, second = polynomials
    target = _rational_literal(center)
    if second.eval(target) == 0:
        raise ValueError("The original denominator must be nonzero at the center, even if a factor cancels.")
    p, q = first.shift(target), second.shift(target)
    coefficients = []
    for k in range(order + 1):
        coefficients.append((p.nth(k) - sum(q.nth(j) * coefficients[k-j] for j in range(1, k+1))) / q.nth(0))
    terms = []
    for k, c in enumerate(coefficients):
        if c != 0:
            power = (symbol-target)**k
            terms.append(c if k == 0 else power if c == 1 else sp.Mul(c, power, evaluate=False))
    centered = sp.Add(*terms, evaluate=False)
    polynomial = sp.Poly(centered, symbol, domain=sp.QQ)
    factor = sp.Poly((symbol-target)**(order+1), symbol, domain=sp.QQ)
    remainder_factor = (first - second * polynomial).exquo(factor).as_expr()
    remainder = (symbol-target)**(order+1) * remainder_factor / second.as_expr()
    residual = sp.cancel(first.as_expr()/second.as_expr() - polynomial.as_expr() - remainder)
    def pack(expr):
        return {"exact": str(expr), "latex": sp.latex(expr)}
    return {"numerator": numerator, "denominator": denominator, "variable": variable,
            "center": center, "center_exact": str(target), "order": order, "domain": "QQ",
            "polynomial": pack(polynomial.as_expr()), "centered_polynomial": pack(centered),
            "coefficients": [{"power": k, **pack(c)} for k, c in enumerate(coefficients)],
            "remainder": pack(remainder), "remainder_factor": pack(remainder_factor),
            "denominator_normalized": pack(second.as_expr()),
            "domain_restriction": f"({second.as_expr()}) != 0",
            "domain_restriction_latex": sp.latex(second.as_expr()) + r" \ne 0",
            "residual": str(residual), "verified": bool(residual == 0)}


def partial_fractions(numerator: str, denominator: str, variable: str = "x") -> dict:
    """Partial fractions over QQ, retaining the original domain restriction."""
    if variable not in ("x", "y", "t"):
        raise ValueError("Variable must be x, y or t.")
    symbol = sp.Symbol(variable)
    polynomials = []
    for name, source in (("numerator", numerator), ("denominator", denominator)):
        try:
            polynomials.append(sp.Poly(parse_expression(source, variable, polynomial=True), symbol, domain=sp.QQ))
        except (sp.PolynomialError, sp.polys.polyerrors.CoercionFailed) as error:
            raise ValueError(f"{name}: use a polynomial with rational coefficients.") from error
    first, second = polynomials
    if second.is_zero:
        raise ValueError("The denominator polynomial cannot be zero.")
    quotient, remainder = first.div(second)
    proper = sp.apart(remainder.as_expr() / second.as_expr(), symbol)
    result = quotient.as_expr() + proper
    ratio = first.as_expr() / second.as_expr()
    residual = sp.cancel(ratio - result)
    def pack(expr):
        return {"exact": str(expr), "latex": sp.latex(expr)}
    return {"numerator": numerator, "denominator": denominator, "variable": variable, "domain": "QQ",
            "numerator_normalized": pack(first.as_expr()), "denominator_normalized": pack(second.as_expr()),
            "normalized": pack(sp.cancel(ratio)), "polynomial_part": pack(quotient.as_expr()),
            "proper_part": pack(proper), "decomposition": pack(result),
            "domain_restriction": f"({second.as_expr()}) != 0",
            "domain_restriction_latex": sp.latex(second.as_expr()) + r" \ne 0",
            "residual": str(residual), "verified": bool(residual == 0)}


def polynomial_gcd(a: str, b: str, variable: str = "x") -> dict:
    """Monic rational polynomial gcd/lcm and an exact Bezout certificate."""
    if variable not in ("x", "y", "t"):
        raise ValueError("Variable must be x, y or t.")
    symbol = sp.Symbol(variable)
    polynomials = []
    for name, source in (("a", a), ("b", b)):
        try:
            polynomials.append(sp.Poly(parse_expression(source, variable, polynomial=True), symbol, domain=sp.QQ))
        except (sp.PolynomialError, sp.polys.polyerrors.CoercionFailed) as error:
            raise ValueError(f"{name}: use a polynomial with rational coefficients.") from error
    first, second = polynomials
    zero = sp.Poly(0, symbol, domain=sp.QQ)
    if first.is_zero and second.is_zero:
        u = v = gcd = lcm = zero
    elif first.is_zero:
        u, v, gcd, lcm = zero, sp.Poly(1 / second.LC(), symbol, domain=sp.QQ), second.monic(), zero
    elif second.is_zero:
        u, v, gcd, lcm = sp.Poly(1 / first.LC(), symbol, domain=sp.QQ), zero, first.monic(), zero
    else:
        u, v, gcd = first.gcdex(second)
        lcm = zero if first.is_zero or second.is_zero else first.mul(second).exquo(gcd).monic()
    residual = first * u + second * v - gcd
    def pack(poly):
        return {"exact": str(poly.as_expr()), "latex": sp.latex(poly.as_expr()),
                "degree": None if poly.is_zero else int(poly.degree())}
    return {"a": a, "b": b, "variable": variable, "domain": "QQ",
            "a_normalized": pack(first), "b_normalized": pack(second),
            "gcd": pack(gcd), "lcm": pack(lcm), "u": pack(u), "v": pack(v),
            "identity": f"({first.as_expr()}) * ({u.as_expr()}) + ({second.as_expr()}) * ({v.as_expr()}) = ({gcd.as_expr()})",
            "residual": str(residual.as_expr()), "verified": bool(residual.is_zero),
            "coprime": bool(gcd.is_one), "both_zero": bool(first.is_zero and second.is_zero)}


def continued_fraction(value: str) -> dict:
    """Finite continued fraction and exact convergents of a rational literal."""
    from sympy.ntheory.continued_fraction import continued_fraction_convergents, continued_fraction_iterator

    number = _rational_literal(value)
    coefficients = list(continued_fraction_iterator(number))
    convergents = list(continued_fraction_convergents(coefficients))
    terms = [str(term) for term in coefficients]
    notation = '[' + terms[0] + ('; ' + ', '.join(terms[1:]) if len(terms) > 1 else '') + ']'
    return {"input": value, "exact": str(number), "coefficients": terms,
            "convergents": [str(term) for term in convergents], "notation": notation,
            "reconstructed": str(convergents[-1]), "verified": convergents[-1] == number}


def integer_pair(a: str, b: str) -> dict:
    """Extended Euclid for decimal integer strings; all integer output stays exact."""
    for name, value in (("a", a), ("b", b)):
        if not isinstance(value, str) or not re.fullmatch(r"[+-]?[0-9]+", value.strip()):
            raise ValueError(f"{name}: write a decimal integer, with an optional sign.")
    first, second = int(a.strip()), int(b.strip())
    old_r, r, old_x, x, old_y, y = abs(first), abs(second), 1, 0, 0, 1
    steps = []
    while r:
        quotient, remainder = divmod(old_r, r)
        steps.append({"dividend": str(old_r), "divisor": str(r),
                      "quotient": str(quotient), "remainder": str(remainder)})
        old_r, r = r, remainder
        old_x, x = x, old_x - quotient * x
        old_y, y = y, old_y - quotient * y
    coefficient_a = old_x * (-1 if first < 0 else 1) if old_r else 0
    coefficient_b = old_y * (-1 if second < 0 else 1) if old_r else 0
    common_multiple = abs(first // old_r * second) if old_r else 0
    identity = first * coefficient_a + second * coefficient_b
    return {"a": a, "b": b, "a_exact": str(first), "b_exact": str(second),
            "gcd": str(old_r), "lcm": str(common_multiple),
            "bezout": {"x": str(coefficient_a), "y": str(coefficient_b), "value": str(identity)},
            "verified": identity == old_r, "steps": steps,
            "both_zero": first == second == 0}


def linear_congruence(a: str, b: str, modulus: str) -> dict:
    """Solve a*x = b modulo a nonzero integer without enumerating residues."""
    for name, value in (("a", a), ("b", b), ("modulus", modulus)):
        if not isinstance(value, str) or not re.fullmatch(r"[+-]?[0-9]+", value.strip()):
            raise ValueError(f"{name}: write a decimal integer, with an optional sign.")
    first, target, written_modulus = int(a.strip()), int(b.strip()), int(modulus.strip())
    positive_modulus = abs(written_modulus)
    if not positive_modulus:
        raise ValueError("modulus: zero is not a valid congruence modulus. Use a nonzero integer.")
    euclid = integer_pair(str(first), str(positive_modulus))
    common = int(euclid["gcd"])
    remainder = target % common
    result = {"a": a, "b": b, "modulus": modulus, "a_exact": str(first),
              "b_exact": str(target), "modulus_exact": str(positive_modulus),
              "gcd": str(common), "compatibility_remainder": str(remainder),
              "bezout": euclid["bezout"]}
    if remainder:
        return {**result, "status": "no_solution", "residue": None, "period": None,
                "residue_count": "0", "all_integers": False, "verified": True}
    period = positive_modulus // common
    residue = (int(euclid["bezout"]["x"]) * (target // common)) % period
    return {**result, "status": "solved", "residue": str(residue), "period": str(period),
            "residue_count": str(common), "all_integers": period == 1,
            "verified": (first * residue - target) % positive_modulus == 0
                        and (first * period) % positive_modulus == 0}


def congruence_system(constraints: list[dict[str, str]]) -> dict:
    """Merge integer residue classes through the existing linear solver."""
    if not isinstance(constraints, list) or not constraints:
        raise ValueError("Provide at least one residue/modulus pair.")
    normalized = []
    for index, item in enumerate(constraints):
        if not isinstance(item, dict):
            raise ValueError(f"Congruence {index + 1}: provide residue and modulus strings.")
        for name in ("residue", "modulus"):
            value = item.get(name)
            if not isinstance(value, str) or not re.fullmatch(r"[+-]?[0-9]+", value.strip()):
                raise ValueError(f"Congruence {index + 1} {name}: write a decimal integer, with an optional sign.")
        modulus = abs(int(item["modulus"].strip()))
        if not modulus:
            raise ValueError(f"Congruence {index + 1}: modulus cannot be zero.")
        normalized.append({"residue": item["residue"], "modulus": item["modulus"],
                           "residue_exact": str(int(item["residue"].strip()) % modulus),
                           "modulus_exact": str(modulus)})
    residue, period = 0, 1
    for index, item in enumerate(normalized):
        difference = int(item["residue_exact"]) - residue
        merge = linear_congruence(str(period), str(difference), item["modulus_exact"])
        if merge["status"] == "no_solution":
            return {"constraints": normalized, "status": "no_solution", "residue": None, "period": None,
                    "all_integers": False, "checks": [], "verified": merge["verified"],
                    "conflict": {"index": index, "prior_residue": str(residue), "prior_period": str(period),
                                 "difference": str(difference), "gcd": merge["gcd"],
                                 "compatibility_remainder": merge["compatibility_remainder"],
                                 "bezout": merge["bezout"]}}
        next_period = period * int(merge["period"])
        residue = (residue + period * int(merge["residue"])) % next_period
        period = next_period
    checks = [{"index": index, "expected": item["residue_exact"], "modulus": item["modulus_exact"],
               "actual": str(residue % int(item["modulus_exact"])),
               "period_remainder": str(period % int(item["modulus_exact"]))}
              for index, item in enumerate(normalized)]
    return {"constraints": normalized, "status": "solved", "residue": str(residue), "period": str(period),
            "all_integers": period == 1, "conflict": None, "checks": checks,
            "verified": all(row["actual"] == row["expected"] and row["period_remainder"] == "0" for row in checks)}


def descriptive_statistics(values: list[str]) -> dict:
    """Describe written rational observations without floating-point rounding."""
    if not isinstance(values, list) or not values:
        raise ValueError("Provide at least one number string.")
    numbers = []
    for index, value in enumerate(values, 1):
        try:
            numbers.append(_rational_literal(value))
        except ValueError as error:
            raise ValueError(f"Observation {index}: {error}") from error
    count = len(numbers)
    total = sum(numbers, sp.S.Zero)
    mean = total / count
    ordered = sorted(numbers)
    median = ordered[count // 2] if count % 2 else (ordered[count // 2 - 1] + ordered[count // 2]) / 2
    squared_deviations = sum(((number - mean) ** 2 for number in numbers), sp.S.Zero)
    population_variance = squared_deviations / count
    sample_variance = squared_deviations / (count - 1) if count > 1 else None
    return {"values": values, "values_exact": [str(number) for number in numbers], "count": count,
            "sum": _value(total), "mean": _value(mean), "median": _value(median),
            "minimum": _value(ordered[0]), "maximum": _value(ordered[-1]),
            "range": _value(ordered[-1] - ordered[0]), "squared_deviations": _value(squared_deviations),
            "population": {"denominator": count, "variance": _value(population_variance),
                           "standard_deviation": _value(sp.sqrt(population_variance))},
            "sample": {"denominator": count - 1, "variance": _value(sample_variance),
                       "standard_deviation": _value(sp.sqrt(sample_variance))} if count > 1 else None}


def matrix_calculate(matrix: list[list[str]], operation: str = "inverse",
                     right_matrix: list[list[str]] | None = None) -> dict:
    """Exact rational determinant, inverse, RREF or ordered matrix product."""
    if operation not in ("determinant", "inverse", "rref", "multiply"):
        raise ValueError("Operation must be determinant, inverse, rref or multiply.")
    if operation != "multiply" and right_matrix is not None:
        raise ValueError("A right matrix is only used by multiply.")

    def parse(rows, prefix=""):
        if not isinstance(rows, list) or not rows or any(not isinstance(row, list) or not row for row in rows):
            raise ValueError(f"{prefix}Provide a nonempty matrix of number strings.")
        columns = len(rows[0])
        normalized = []
        for row_index, row in enumerate(rows, 1):
            if len(row) != columns:
                raise ValueError(f"{prefix}Row {row_index}: all rows must have {columns} columns.")
            parsed = []
            for column_index, value in enumerate(row, 1):
                try:
                    parsed.append(_rational_literal(value))
                except ValueError as error:
                    raise ValueError(f"{prefix}Row {row_index}, column {column_index}: {error}") from error
            normalized.append(parsed)
        return sp.Matrix(normalized)

    source = parse(matrix)

    def strings(value: sp.Matrix) -> list[list[str]]:
        return [[str(cell) for cell in row] for row in value.tolist()]

    result = {"operation": operation, "original_matrix": matrix, "matrix_exact": strings(source),
              "rows": source.rows, "columns": source.cols, "status": "computed"}
    if operation == "multiply":
        right = parse(right_matrix, "Matrix B: ")
        if source.cols != right.rows:
            raise ValueError(f"A has {source.cols} columns but B has {right.rows} rows; these dimensions must match for A * B.")
        product = source * right
        return {**result, "original_right_matrix": right_matrix, "right_matrix_exact": strings(right),
                "right_rows": right.rows, "right_columns": right.cols, "product_exact": strings(product),
                "product_rows": product.rows, "product_columns": product.cols}
    if operation == "rref":
        reduced, pivots = source.rref()
        return {**result, "rref_exact": strings(reduced), "rank": len(pivots),
                "pivot_columns_one_based": [index + 1 for index in pivots]}
    if source.rows != source.cols:
        raise ValueError("Determinant and inverse need a square matrix; use rref for rectangular matrices.")
    determinant = source.det()
    result["determinant_exact"] = str(determinant)
    if operation == "determinant":
        return result
    if determinant == 0:
        return {**result, "status": "singular", "inverse_exact": None, "verified": None}
    inverse = source.inv()
    residuals = source * inverse - sp.eye(source.rows)
    return {**result, "inverse_exact": strings(inverse), "residuals_exact": strings(residuals),
            "verified": residuals == sp.zeros(source.rows)}


def convert_base(number: str, source_base: int = 10, target_base: int = 2) -> dict:
    """Convert a signed integer exactly; signs are not two's-complement words."""
    if type(source_base) is not int or type(target_base) is not int or not 2 <= source_base <= 36 or not 2 <= target_base <= 36:
        raise ValueError("Source and target bases must be integers from 2 to 36.")
    if not isinstance(number, str) or not number.strip():
        raise ValueError("Provide an integer as a string.")
    try:
        value = int(number.strip(), source_base)
    except ValueError as error:
        raise ValueError(f"The integer is not valid in base {source_base}: {error}") from error
    alphabet = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ"

    def encode(base: int) -> str:
        remaining, digits = abs(value), []
        while remaining:
            remaining, digit = divmod(remaining, base)
            digits.append(alphabet[digit])
        return ("-" if value < 0 else "") + ("".join(reversed(digits)) or "0")

    result = encode(target_base)
    return {"number": number, "source_base": source_base, "target_base": target_base,
            "source_normalized": encode(source_base), "result": result, "decimal": str(value),
            "equivalents": [{"base": base, "value": encode(base)} for base in (2, 8, 10, 16)],
            "verified": int(result, target_base) == value}


def interpolate(points: list[list[str]], variable: str = "x") -> dict:
    """Interpolate rational pairs and check the polynomial at every input."""
    if variable not in ("x", "y", "t"):
        raise ValueError("Variable must be x, y or t.")
    if not isinstance(points, list) or not points:
        raise ValueError("Provide at least one pair of number strings.")
    normalized, seen = [], {}
    for index, pair in enumerate(points, 1):
        if not isinstance(pair, list) or len(pair) != 2:
            raise ValueError(f"Row {index}: provide exactly two number strings.")
        try:
            abscissa, ordinate = (_rational_literal(value) for value in pair)
        except ValueError as error:
            raise ValueError(f"Row {index}: {error}") from error
        if abscissa in seen:
            raise ValueError(f"Row {index}: abscissa {abscissa} repeats row {seen[abscissa]}; use distinct abscissas.")
        seen[abscissa] = index
        normalized.append((abscissa, ordinate))
    symbol = sp.Symbol(variable)
    polynomial = sp.Poly(sp.interpolate(normalized, symbol), symbol)
    rows = []
    for written, (abscissa, ordinate) in zip(points, normalized):
        evaluated = polynomial.eval(abscissa)
        rows.append({"point": written, "x_exact": str(abscissa), "y_exact": str(ordinate),
                     "evaluated_exact": str(evaluated), "residual_exact": str(evaluated - ordinate)})
    return {"variable": variable, "points": points, **_value(polynomial.as_expr()),
            "degree": None if polynomial.is_zero else int(polynomial.degree()), "is_zero": bool(polynomial.is_zero),
            "coefficients_exact": [str(value) for value in polynomial.all_coeffs()],
            "rows": rows, "verified": all(row["residual_exact"] == "0" for row in rows)}


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
