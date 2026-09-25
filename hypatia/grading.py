"""answer_grade: TEST/COMPLETAR deterministically (ports of src/domain/scoring.ts),
DESARROLLO/PRACTICO with a model rubric, or keyword matching when no model resolves."""

from __future__ import annotations

import re
from typing import Any

from . import ai, backend
from .hashing import normalize_text

SUGGESTED = {"correct": "good", "partial": "hard", "wrong": "again"}


# ---------- scoring.ts ports ----------

def score_test(question: dict, selected_ids: list[str]) -> str:
    correct = set(question.get("correctOptionIds") or [])
    selected = set(selected_ids or [])
    return "CORRECT" if correct == selected else "WRONG"


def score_completar(question: dict, blank_answers: dict[str, str]) -> str:
    for blank in question.get("blanks") or []:
        user_input = normalize_text(blank_answers.get(blank.get("id"), "") or "")
        accepted = [normalize_text(a) for a in blank.get("accepted") or []]
        if user_input not in accepted:
            return "WRONG"
    return "CORRECT"


def keyword_matches(question: dict, free_text: str) -> list[str]:
    normalized = normalize_text(free_text or "")
    return [kw for kw in question.get("keywords") or [] if normalize_text(kw) in normalized]


# ---------- answer parsing ----------

def parse_test_answer(question: dict, answer: Any) -> list[str]:
    """Option ids from ids, letters (a/B), 1-based numbers or option texts."""
    options = question.get("options") or []
    if not isinstance(answer, list):
        whole = next((o["id"] for o in options if normalize_text(o.get("text") or "") == normalize_text(str(answer or ""))), None)
        if whole is not None:
            return [whole]
    parts = answer if isinstance(answer, list) else re.split(r"[,;/]|\s+y\s+|\s+and\s+", str(answer or ""))
    ids: list[str] = []
    for raw in parts:
        token = str(raw).strip().strip(".)").strip()
        if not token:
            continue
        match = next((o["id"] for o in options if o.get("id") == token), None)
        if match is None and len(token) == 1 and token.isalpha():
            index = ord(token.lower()) - 97
            match = options[index]["id"] if 0 <= index < len(options) else None
        if match is None and token.isdigit():
            index = int(token) - 1
            match = options[index]["id"] if 0 <= index < len(options) else None
        if match is None:
            match = next((o["id"] for o in options if normalize_text(o.get("text") or "") == normalize_text(token)), None)
        if match is None:
            raise ValueError(f"«{token}» is not one of the options.")
        if match not in ids:
            ids.append(match)
    return ids


def parse_blank_answers(question: dict, answer: Any) -> dict[str, str]:
    blanks = question.get("blanks") or []
    if isinstance(answer, dict):
        return {str(k): str(v) for k, v in answer.items()}
    values = answer if isinstance(answer, list) else ([answer] if len(blanks) == 1 else re.split(r"[;|]|,\s*", str(answer or "")))
    return {b.get("id"): str(values[i]).strip() if i < len(values) else "" for i, b in enumerate(blanks)}


def _correct_answer(question: dict) -> Any:
    if question.get("type") == "TEST":
        ids = set(question.get("correctOptionIds") or [])
        return [o.get("text") for o in question.get("options") or [] if o.get("id") in ids]
    if question.get("type") == "COMPLETAR":
        return {b.get("id"): b.get("accepted") for b in question.get("blanks") or []}
    return question.get("modelAnswer")


# ---------- entry point ----------

def grade(services, question: dict, answer: Any) -> dict:
    qtype = question.get("type")
    base = {"questionId": question["id"], "type": qtype, "correctAnswer": _correct_answer(question),
            "explanation": question.get("explanation")}
    if qtype in ("TEST", "COMPLETAR"):
        result = (score_test(question, parse_test_answer(question, answer)) if qtype == "TEST"
                  else score_completar(question, parse_blank_answers(question, answer)))
        verdict = "correct" if result == "CORRECT" else "wrong"
        return {**base, "verdict": verdict, "score": 10 if verdict == "correct" else 0,
                "feedback": "Correcto." if verdict == "correct" else "Incorrecto.", "missing": [],
                "suggestedGrade": SUGGESTED[verdict], "model": None}
    return {**base, **_grade_free_text(services, question, str(answer or ""))}


def _grade_free_text(services, question: dict, answer: str) -> dict:
    keywords = question.get("keywords") or []
    matched = keyword_matches(question, answer)
    fallback = {
        "verdict": None, "score": None, "feedback": None,
        "missing": [k for k in keywords if k not in matched], "matchedKeywords": matched,
        "suggestedGrade": None, "model": None, "modelAnswer": question.get("modelAnswer"),
    }
    if not answer.strip():
        return {**fallback, "verdict": "wrong", "score": 0, "feedback": "Respuesta en blanco.", "suggestedGrade": "again"}
    try:
        result = ai.chat(services, backend.build_grade_messages(question, answer), max_tokens=backend.GRADE_MAX_TOKENS,
                         temperature=0.1, response_format={"type": "json_object"})
    except (ai.Unavailable, ai.BackendError) as error:
        return {**fallback, "note": f"No model could grade this ({error}). Compare the answer with `modelAnswer` "
                                    "yourself (matched keywords are a hint only) and pick the grade."}
    data = ai.parse_json(result.text)
    verdict = str(data.get("verdict", "")).lower() if isinstance(data, dict) else ""
    if verdict not in SUGGESTED:
        return {**fallback, "model": result.model,
                "note": "The model's reply was not the expected JSON; judge against `modelAnswer` yourself."}
    try:
        score = max(0.0, min(10.0, float(data.get("score"))))
    except (TypeError, ValueError):
        score = {"correct": 10.0, "partial": 5.0, "wrong": 0.0}[verdict]
    missing = [str(m) for m in data.get("missing") or [] if str(m).strip()]
    return {"verdict": verdict, "score": score, "feedback": str(data.get("feedback") or ""), "missing": missing,
            "matchedKeywords": matched, "suggestedGrade": SUGGESTED[verdict], "model": result.model,
            "modelAnswer": question.get("modelAnswer")}
