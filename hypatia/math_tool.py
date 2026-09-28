"""Small exact-math calculator for the assistant, independent of study data."""

from __future__ import annotations

import ast

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
