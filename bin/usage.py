#!/usr/bin/env python3
"""session-radar 的 token 用量统计。

数据源：~/.claude/projects/**/*.jsonl（Claude Code 记录的每次 API 调用，usage 来自接口返回值）。
- 增量扫描：每个文件记住已读到的字节位置，只读新追加的部分
- 去重：按 (message.id, requestId)，会话恢复/分叉会把历史复制进新文件（实测约 62% 是重复）
- 计价：Anthropic 官方价目（2026-09-25），缓存写入分 5 分钟 / 1 小时两档，快速模式 2 倍
  注意：Max 订阅下这是「按 API 标价折算的等价金额」，不是实际账单

用法：
  usage.py scan                          只扫描
  usage.py summary --range today [--range 7d ...] [--scan]
      range: today | yesterday | 7d | 30d | month | lastmonth | all | YYYY-MM-DD:YYYY-MM-DD
"""
import argparse, datetime as dt, fcntl, glob, json, os, sqlite3, sys, time

HOME = os.path.expanduser("~")
LOGS = os.path.join(HOME, ".claude", "projects")
DATA = os.path.join(HOME, ".claude", "session-radar-data")   # 放在插件目录外，更新插件时不会被复制
DB = os.path.join(DATA, "usage.db")
LOCK = os.path.join(DATA, "scan.lock")

# $/百万 token：输入, 输出, 缓存写入(5分钟), 缓存写入(1小时), 缓存读取
PRICES = {
    "claude-fable-5-1":  (10.0, 50.0, 12.5, 20.0, 0.25),
    "claude-mythos-5-1": (10.0, 50.0, 12.5, 20.0, 0.25),
    "claude-fable-5":    (10.0, 50.0, 12.5, 20.0, 1.00),
    "claude-opus-5-5":   (4.0, 20.0, 5.0, 8.0, 0.20),
    "claude-opus-5":     (5.0, 25.0, 6.25, 10.0, 0.50),
    "claude-opus-4-8":   (5.0, 25.0, 6.25, 10.0, 0.50),
    "claude-opus-4-7":   (5.0, 25.0, 6.25, 10.0, 0.50),
    "claude-opus-4-6":   (5.0, 25.0, 6.25, 10.0, 0.50),
    "claude-sonnet-5-5": (2.0, 10.0, 2.5, 4.0, 0.20),
    "claude-sonnet-5":   (2.0, 10.0, 2.5, 4.0, 0.20),
    "claude-sonnet-4-6": (3.0, 15.0, 3.75, 6.0, 0.30),
    "claude-haiku-4-5":  (1.0, 5.0, 1.25, 2.0, 0.10),
}


def price_of(model):
    if model in PRICES:
        return PRICES[model]
    for k, v in PRICES.items():          # 兼容带日期后缀的旧式 ID
        if model and model.startswith(k):
            return v
    return None


def connect():
    os.makedirs(DATA, exist_ok=True)
    c = sqlite3.connect(DB, timeout=30)
    c.executescript("""
      PRAGMA journal_mode=WAL;
      CREATE TABLE IF NOT EXISTS files(path TEXT PRIMARY KEY, offset INTEGER, size INTEGER, mtime REAL);
      CREATE TABLE IF NOT EXISTS msgs(
        key TEXT PRIMARY KEY, ts INTEGER, day TEXT, project TEXT, model TEXT, speed TEXT,
        inp INTEGER, out INTEGER, cw5 INTEGER, cw1h INTEGER, cr INTEGER, cost REAL);
      CREATE INDEX IF NOT EXISTS msgs_day ON msgs(day);
      CREATE TABLE IF NOT EXISTS meta(k TEXT PRIMARY KEY, v TEXT);
    """)
    return c


def parse_line(line):
    try:
        d = json.loads(line)
    except Exception:
        return None
    m = d.get("message")
    if not isinstance(m, dict):
        return None
    u = m.get("usage")
    model = m.get("model")
    if not isinstance(u, dict) or not model or model == "<synthetic>":
        return None
    key = "%s:%s" % (m.get("id") or d.get("uuid"), d.get("requestId") or "")
    ts_raw = d.get("timestamp")
    try:
        ts = dt.datetime.fromisoformat(ts_raw.replace("Z", "+00:00"))
    except Exception:
        return None
    inp = int(u.get("input_tokens") or 0)
    out = int(u.get("output_tokens") or 0)
    cr = int(u.get("cache_read_input_tokens") or 0)
    cc = u.get("cache_creation") or {}
    cw1h = int(cc.get("ephemeral_1h_input_tokens") or 0)
    cw_total = int(u.get("cache_creation_input_tokens") or 0)
    cw5 = int(cc.get("ephemeral_5m_input_tokens") or 0) if cc else cw_total
    if cw5 + cw1h < cw_total:            # 分档信息不全时，差额按 5 分钟档计
        cw5 += cw_total - cw5 - cw1h
    speed = u.get("speed") or "standard"
    p = price_of(model)
    cost = None
    if p:
        mult = 2.0 if speed == "fast" else 1.0
        cost = mult * (inp * p[0] + out * p[1] + cw5 * p[2] + cw1h * p[3] + cr * p[4]) / 1e6
    local = ts.astimezone()
    return (key, int(ts.timestamp() * 1000), local.strftime("%Y-%m-%d"), d.get("cwd") or "",
            model, speed, inp, out, cw5, cw1h, cr, cost)


def scan(c):
    """增量扫描；拿不到锁（别的 session 正在扫）就直接返回。"""
    os.makedirs(DATA, exist_ok=True)
    lock = open(LOCK, "w")
    try:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except OSError:
        return {"scanned": False, "reason": "locked"}
    t0 = time.time()
    known = {r[0]: r[1:] for r in c.execute("SELECT path, offset, size, mtime FROM files")}
    files_read = rows = 0
    for path in glob.glob(os.path.join(LOGS, "**", "*.jsonl"), recursive=True):
        try:
            st = os.stat(path)
        except OSError:
            continue
        off, size, mtime = known.get(path, (0, -1, -1))
        if st.st_size == size and st.st_mtime == mtime:
            continue
        if st.st_size < off:              # 文件被重写：从头读（去重保证不会重复计数）
            off = 0
        batch = []
        with open(path, "rb") as f:
            f.seek(off)
            chunk = f.read()
        end = chunk.rfind(b"\n")
        if end < 0:
            continue                       # 还没有完整的一行
        for line in chunk[: end + 1].splitlines():
            if b'"usage"' not in line:
                continue
            r = parse_line(line.decode("utf-8", "ignore"))
            if r:
                batch.append(r)
        if batch:
            c.executemany("INSERT OR IGNORE INTO msgs VALUES (?,?,?,?,?,?,?,?,?,?,?,?)", batch)
            rows += len(batch)
        c.execute("INSERT OR REPLACE INTO files VALUES (?,?,?,?)", (path, off + end + 1, st.st_size, st.st_mtime))
        files_read += 1
    c.execute("INSERT OR REPLACE INTO meta VALUES ('last_scan', ?)", (str(int(time.time() * 1000)),))
    c.commit()
    return {"scanned": True, "files": files_read, "rows": rows, "seconds": round(time.time() - t0, 2)}


def resolve_range(r):
    today = dt.date.today()
    if r == "today":
        a = b = today
    elif r == "yesterday":
        a = b = today - dt.timedelta(days=1)
    elif r in ("7d", "30d"):
        a, b = today - dt.timedelta(days=int(r[:-1]) - 1), today
    elif r == "month":
        a, b = today.replace(day=1), today
    elif r == "lastmonth":
        b = today.replace(day=1) - dt.timedelta(days=1)
        a = b.replace(day=1)
    elif r == "all":
        a, b = dt.date(2000, 1, 1), today
    else:
        x, y = r.split(":")
        a, b = dt.date.fromisoformat(x), dt.date.fromisoformat(y)
    return a.isoformat(), b.isoformat()


def summary(c, r):
    a, b = resolve_range(r)
    q = "FROM msgs WHERE day BETWEEN ? AND ?"
    agg = "COUNT(*), SUM(inp), SUM(out), SUM(cw5)+SUM(cw1h), SUM(cr), SUM(COALESCE(cost,0))"

    def pack(row):
        n, i, o, cw, cr, cost = [x or 0 for x in row]
        return {"requests": n, "input": i, "output": o, "cacheWrite": cw, "cacheRead": cr,
                "total": i + o + cw + cr, "cost": round(cost, 2)}

    out = {"range": r, "from": a, "to": b,
           "totals": pack(c.execute("SELECT %s %s" % (agg, q), (a, b)).fetchone())}
    out["byDay"] = [dict(day=row[0], **pack(row[1:])) for row in
                    c.execute("SELECT day, %s %s GROUP BY day ORDER BY day" % (agg, q), (a, b))]
    out["byModel"] = [dict(model=row[0], **pack(row[1:])) for row in
                      c.execute("SELECT model, %s %s GROUP BY model ORDER BY 7 DESC" % (agg, q), (a, b))]
    out["byProject"] = [dict(project=row[0], **pack(row[1:])) for row in
                        c.execute("SELECT project, %s %s GROUP BY project ORDER BY 7 DESC LIMIT 10" % (agg, q), (a, b))]
    out["unpriced"] = [row[0] for row in
                       c.execute("SELECT DISTINCT model %s AND cost IS NULL" % q, (a, b))]
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("cmd", choices=["scan", "summary"])
    ap.add_argument("--range", action="append", default=[])
    ap.add_argument("--scan", action="store_true")
    args = ap.parse_args()
    c = connect()
    res = {}
    if args.cmd == "scan" or args.scan:
        res["scan"] = scan(c)
    if args.cmd == "summary":
        res["ranges"] = {r: summary(c, r) for r in (args.range or ["today"])}
    row = c.execute("SELECT v FROM meta WHERE k='last_scan'").fetchone()
    res["lastScan"] = int(row[0]) if row else None
    json.dump(res, sys.stdout, ensure_ascii=False)


if __name__ == "__main__":
    main()
