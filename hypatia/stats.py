"""Per-deck and total statistics: counts, retention, streak, 7-day forecast.

Every function takes `now` explicitly (never reads the wall clock) so tests
can pin a fixed instant, including one that crosses local midnight.
"""

from __future__ import annotations

import datetime as dt

from .db import Database

RETENTION_WINDOW_DAYS = 30
FORECAST_DAYS = 7


def _local_date(epoch: float) -> dt.date:
    return dt.datetime.fromtimestamp(epoch).date()


def _day_bounds(day: dt.date) -> tuple[float, float]:
    start = dt.datetime.combine(day, dt.time.min).timestamp()
    end = dt.datetime.combine(day + dt.timedelta(days=1), dt.time.min).timestamp()
    return start, end


class Stats:
    def __init__(self, db: Database):
        self.db = db

    def _card_counts(self, deck_id: int | None, now: float) -> dict:
        sql = """SELECT COUNT(*) AS cards,
                        SUM(CASE WHEN state = 'new' THEN 1 ELSE 0 END) AS new,
                        SUM(CASE WHEN state = 'learning' THEN 1 ELSE 0 END) AS learning,
                        SUM(CASE WHEN state = 'review' THEN 1 ELSE 0 END) AS review,
                        SUM(CASE WHEN state = 'lapsed' THEN 1 ELSE 0 END) AS lapsed,
                        SUM(suspended) AS suspended,
                        SUM(CASE WHEN suspended = 0 AND due_at <= ? THEN 1 ELSE 0 END) AS due_now
                 FROM cards"""
        params: list = [now]
        if deck_id is not None:
            sql += " WHERE deck_id = ?"
            params.append(deck_id)
        with self.db.lock:
            row = self.db.conn.execute(sql, params).fetchone()
        return {k: (row[k] or 0) for k in ("cards", "new", "learning", "review", "lapsed", "suspended", "due_now")}

    def _reviewed_today(self, deck_id: int | None, now: float) -> int:
        start, end = _day_bounds(_local_date(now))
        sql = "SELECT COUNT(*) FROM reviews WHERE reviewed_at >= ? AND reviewed_at < ?"
        params: list = [start, end]
        if deck_id is not None:
            sql += " AND deck_id = ?"
            params.append(deck_id)
        with self.db.lock:
            return self.db.conn.execute(sql, params).fetchone()[0]

    def _retention(self, deck_id: int | None, now: float) -> float | None:
        since = now - RETENTION_WINDOW_DAYS * 86400
        sql = "SELECT grade FROM reviews WHERE was_new = 0 AND reviewed_at >= ?"
        params: list = [since]
        if deck_id is not None:
            sql += " AND deck_id = ?"
            params.append(deck_id)
        with self.db.lock:
            grades = [r[0] for r in self.db.conn.execute(sql, params).fetchall()]
        if not grades:
            return None
        good_or_easy = sum(1 for g in grades if g >= 2)
        return round(good_or_easy / len(grades), 4)

    def _streak(self, deck_id: int | None, now: float) -> int:
        sql = "SELECT DISTINCT reviewed_at FROM reviews"
        params: list = []
        if deck_id is not None:
            sql += " WHERE deck_id = ?"
            params.append(deck_id)
        with self.db.lock:
            rows = self.db.conn.execute(sql, params).fetchall()
        days = {_local_date(r[0]) for r in rows}
        today = _local_date(now)
        day = today if today in days else today - dt.timedelta(days=1)
        if day not in days:
            return 0
        count = 0
        while day in days:
            count += 1
            day -= dt.timedelta(days=1)
        return count

    def _forecast(self, deck_id: int | None, now: float) -> list[dict]:
        today = _local_date(now)
        sql = "SELECT due_at FROM cards WHERE suspended = 0"
        params: list = []
        if deck_id is not None:
            sql += " AND deck_id = ?"
            params.append(deck_id)
        with self.db.lock:
            due_dates = self.db.conn.execute(sql, params).fetchall()
        out = []
        for offset in range(FORECAST_DAYS):
            day = today + dt.timedelta(days=offset)
            _, end = _day_bounds(day)
            if offset == 0:
                count = sum(1 for r in due_dates if r[0] < end)  # today folds in anything overdue
            else:
                start, _ = _day_bounds(day)
                count = sum(1 for r in due_dates if start <= r[0] < end)
            out.append({"date": day.isoformat(), "due": count})
        return out

    def deck_stats(self, deck_id: int | None, now: float) -> dict:
        counts = self._card_counts(deck_id, now)
        return {
            "deck_id": deck_id,
            "cards": counts["cards"], "new": counts["new"], "learning": counts["learning"],
            "review": counts["review"], "lapsed": counts["lapsed"], "suspended": counts["suspended"],
            "due_now": counts["due_now"], "reviewed_today": self._reviewed_today(deck_id, now),
            "retention_30d": self._retention(deck_id, now), "streak_days": self._streak(deck_id, now),
            "forecast_7d": self._forecast(deck_id, now),
        }

    def new_seen_today_by_deck(self, now: float) -> dict[int, int]:
        start, end = _day_bounds(_local_date(now))
        with self.db.lock:
            rows = self.db.conn.execute(
                "SELECT deck_id, COUNT(*) AS n FROM reviews WHERE was_new = 1 AND reviewed_at >= ? AND reviewed_at < ? GROUP BY deck_id",
                (start, end),
            ).fetchall()
        return {r["deck_id"]: r["n"] for r in rows}
