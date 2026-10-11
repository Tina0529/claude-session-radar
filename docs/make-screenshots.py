"""生成 README 用的演示截图（全部是虚构的演示数据，不读取任何真实 session）。
用法：python3 docs/make-screenshots.py docs/images（需要本机装有 Google Chrome）
"""
import os, subprocess, sys

OUT = sys.argv[1]
HERE = os.path.dirname(os.path.abspath(__file__))
CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"

CSS = """
:root{--bg:#262624;--panel:#1f1e1d;--line:#3a3936;--fg:#e8e6e0;--dim:#9a988f;--btn:#34332f;
--green:#5fb760;--cyan:#4fb3c8;--yellow:#e0b34a;--red:#e0635a;--accent:#d97757}
*{box-sizing:border-box;margin:0;padding:0}
html,body{background:transparent}
body{font-family:-apple-system,"PingFang SC","Hiragino Sans GB",sans-serif;color:var(--fg);font-size:14px;line-height:1.5;
-webkit-font-smoothing:antialiased;padding:24px}
.dim{color:var(--dim)}.g{color:var(--green)}.c{color:var(--cyan)}.y{color:var(--yellow)}.r{color:var(--red)}.b{font-weight:600}
.acc{color:var(--accent)}
.btn{display:inline-block;background:var(--btn);border-radius:6px;padding:1px 8px;margin-right:6px;white-space:nowrap}
.card{background:var(--bg);border:1px solid var(--line);border-radius:12px;box-shadow:0 18px 50px rgba(0,0,0,.35)}
.nw{white-space:nowrap}
/* 看板 */
.pane{width:440px;padding:14px 16px}
.pane h4{font-weight:500;color:var(--dim);font-size:13px;margin-bottom:10px}
.tabs{margin-bottom:12px}
.row{margin-bottom:10px}
.row .t{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.row .m{color:var(--dim);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;padding-left:22px;font-size:13px}
.hint{color:var(--dim);font-size:12px;margin-top:4px}
/* 横条 */
.band{width:760px;padding:10px 14px;background:#2d2c29;border-radius:10px}
.band div{white-space:nowrap;margin:3px 0}
.prompt{margin-top:8px;border:1px solid var(--line);border-radius:12px;padding:12px 14px;color:var(--dim)}
/* 用量 */
.sec{margin-top:12px}.sec .b{margin-bottom:2px}
.bar{display:inline-block;height:10px;background:var(--cyan);border-radius:2px;vertical-align:middle;margin:0 6px}
.mono{font-variant-numeric:tabular-nums}
/* 通知 */
.ntf{width:400px;padding:12px 14px;border-radius:16px;background:rgba(48,47,45,.92);border:1px solid #4a4945;
box-shadow:0 12px 40px rgba(0,0,0,.45);display:flex;gap:11px;align-items:flex-start;backdrop-filter:blur(20px)}
.ntf .ic{width:38px;height:38px;border-radius:9px;background:linear-gradient(145deg,#4a4945,#2a2927);display:flex;
align-items:center;justify-content:center;font:600 15px ui-monospace,Menlo,monospace;color:#cfcdc6;flex:none}
.ntf .tx{flex:1;min-width:0;font-size:13px;line-height:1.35}
.ntf .tx .h{font-weight:600}.ntf .tx .s{font-weight:500}
.ntf .tm{color:var(--dim);font-size:12px;flex:none}
/* 窗口 */
.win{width:1440px;height:820px;display:flex;flex-direction:column;overflow:hidden}
.bar0{height:44px;display:flex;align-items:center;gap:8px;padding:0 16px;border-bottom:1px solid var(--line)}
.dot{width:12px;height:12px;border-radius:50%}
.main{flex:1;display:flex;min-height:0}
.chat{flex:1;display:flex;flex-direction:column;padding:22px 34px 18px;min-width:0}
.msgs{flex:1;overflow:hidden}
.u{margin-left:auto;max-width:70%;background:#33322f;border-radius:14px;padding:9px 14px;margin-bottom:16px;width:fit-content}
.a{margin-bottom:16px;max-width:92%}
.a li{margin-left:20px}
.side{width:440px;border-left:1px solid var(--line);background:var(--panel)}
.float{position:absolute;right:20px;top:14px}
.stage{position:relative;padding-top:72px}
"""

def page(body, w, h, name):
    html = f'<!doctype html><meta charset="utf-8"><style>{CSS}</style><body>{body}</body>'
    src = os.path.join(HERE, name + ".html")
    open(src, "w").write(html)
    png = os.path.join(OUT, name + ".png")
    subprocess.run([CHROME, "--headless=new", "--disable-gpu", "--hide-scrollbars", "--force-device-scale-factor=2",
                    "--default-background-color=00000000", f"--window-size={w},{h}", f"--screenshot={png}",
                    "file://" + src], check=True, capture_output=True)
    print(png)

# ── 演示数据 ─────────────────────────────────────────
SESSIONS = [
    # 状态, 名字, 年龄, 项目, 第二行, 未看, 可跳转
    ("cur", "落地页改版", "8秒前", "website", "用时 41s · 工具 4 次 · 你说「把首屏按钮改成深色」", False),
    ("bg", "竞品调研", "1分钟前", "research", "主回合 12s，后台 3 个任务在跑 · 工具 2 次", False),
    ("run", "API 文档整理", "2分钟前", "api-docs", "进行中 · 工具 7 次 · 你说「补全错误码一节」", False),
    ("done", "周报生成", "5分钟前", "reports", "用时 3m12s · 工具 18 次 · 你说「按上周的格式出本周周报」", True),
    ("err", "数据清洗脚本", "12分钟前", "etl", "用时 1m05s · 工具 9 次 · 你说「把空值行剔除后重跑」", True),
    ("done", "单元测试补齐", "25分钟前", "backend", "用时 6m40s · 工具 42 次 · 你说「覆盖率提到 80%」", False),
    ("done", "博客草稿", "1小时前", "blog", "用时 2m02s · 工具 3 次 · 你说「语气再轻松一点」", False),
    ("ab", "旧版迁移", "3小时前", "legacy", "用时 58s · 工具 5 次", False),
]

def pane_rows():
    out, hk = [], 0
    for st, name, age, proj, meta, unseen in SESSIONS:
        can = st != "cur"
        key = ""
        if can:
            hk += 1
            key = f'<span class="acc">{hk}:</span> '
        dot = '<span class="y">● </span>' if unseen else ""
        chip = {"cur": '<span class="g b">✅</span>', "done": '<span class="g b">✅</span>',
                "bg": '<span class="c b">🔄 后台运行中 3</span>', "run": '<span class="y b">⏳ 运行中</span>',
                "err": '<span class="r b">❌ 出错</span>', "ab": '<span class="dim b">⏹ 已中断</span>'}[st]
        cur = ' <span class="c">(当前)</span>' if st == "cur" else ""
        arrow = "  ↗" if can else ""
        out.append(f'<div class="row"><div class="t">{key}{dot}{chip} <span class="b">{name}</span>{cur}'
                   f'<span class="dim">&nbsp;&nbsp;{age}{arrow}</span></div>'
                   f'<div class="m">📁 {proj} · {meta}</div></div>')
    return "".join(out)

def pane_sessions():
    return ('<div class="pane"><h4>最近 session</h4>'
            '<div class="tabs"><span class="btn">● 会话</span><span class="btn">用量</span></div>'
            + pane_rows() +
            '<div class="hint">点 session 名字直接切过去 · 黄点 = 跑完后还没看过<br>🔄 = 后台 subagent 还在跑</div></div>')

DAYS = [("10-05", 38.12, "9820.4万"), ("10-06", 22.40, "5310.2万"), ("10-07", 71.85, "1.21亿"),
        ("10-08", 64.30, "1.08亿"), ("10-09", 88.96, "1.47亿"), ("10-10", 53.24, "9104.6万"), ("10-11", 73.50, "1.20亿")]

def pane_usage():
    mx = max(d[1] for d in DAYS)
    days = "".join(f'<div class="mono nw"><span class="dim" style="display:inline-block;width:44px">{d}</span><span class="bar" style="width:{round(c / mx * 170)}px"></span>'
                   f'${c:.2f}<span class="dim"> {t}</span></div>' for d, c, t in DAYS)
    models = [("opus-5-5", 301.20, 73, "4.92亿"), ("sonnet-5-5", 96.85, 23, "1.71亿"), ("haiku-4-5", 14.32, 4, "2140.7万")]
    m = "".join(f'<div class="nw">{n}&nbsp;&nbsp;<span class="b">${c:.2f}</span><span class="dim">&nbsp;&nbsp;{p}% · {t}</span></div>' for n, c, p, t in models)
    projs = [("website", 128.40, "2.03亿"), ("research", 96.15, "1.62亿"), ("backend", 81.22, "1.37亿"),
             ("reports", 52.90, "8640.3万"), ("api-docs", 31.48, "5210.9万"), ("blog", 22.22, "3605.4万")]
    p = "".join(f'<div class="nw">📁 {n}&nbsp;&nbsp;<span class="b">${c:.2f}</span><span class="dim">&nbsp;&nbsp;{t}</span></div>' for n, c, t in projs)
    rng = "".join(f'<span class="btn">{x}</span>' for x in ["今天", "昨天", "●7天", "30天", "本月", "上月", "全部", "↻"])
    return ('<div class="pane"><h4>最近 session</h4>'
            '<div class="tabs"><span class="btn">会话</span><span class="btn">● 用量</span></div>'
            f'<div style="line-height:2">{rng}</div>'
            '<div class="sec"><div class="dim">2026-10-05 ~ 2026-10-11 · 请求 4,812 次</div>'
            '<div><span class="b">6.84亿 token</span>&nbsp; ≈ <span class="b g">$412.37</span></div>'
            '<div class="dim nw">输入 152.3万 · 输出 418.6万 · 缓存写 3820.5万 · 缓存读 6.41亿</div></div>'
            f'<div class="sec"><div class="b">按天</div>{days}</div>'
            f'<div class="sec"><div class="b">按模型</div>{m}</div>'
            f'<div class="sec"><div class="b">按项目（前 10）</div>{p}</div>'
            '<div class="hint" style="margin-top:12px">按 Anthropic 官方 API 标价折算（Max 订阅非实际账单）<br>已去重 · 更新于 12秒前</div></div>')

def band(open_=False):
    n1 = '<div><span class="btn">✅ 周报生成 · 完成 ↗</span><span class="dim">&nbsp;📁 reports · 5分钟前&nbsp;</span><span class="btn">×</span></div>'
    n2 = '<div><span class="btn">❌ 数据清洗脚本 · 出错 ↗</span><span class="dim">&nbsp;📁 etl · 12分钟前&nbsp;</span><span class="btn">×</span></div>'
    last = (f'<div><span class="btn">{"▾ 收起看板" if open_ else "▸ 最近 session"}</span>'
            '<span class="dim">&nbsp;近1小时 </span><span class="g">✅4 </span><span class="r">❌1 </span>'
            '<span class="y">⏳1 </span><span class="c">🔄1 </span>'
            '<span class="dim">&nbsp;· 今天 1.20亿 token ≈ $73.50</span></div>')
    return f'<div class="band">{n1}{n2}{last}</div>'

def notification():
    return ('<div class="ntf"><div class="ic">&gt;_</div><div class="tx">'
            '<div class="h nw">✅ 完成｜周报生成</div><div class="s nw">📁 reports · 用时 3m12s · 工具 18 次</div>'
            '<div>你说：「按上周的格式出本周周报」</div></div><div class="tm">现在</div></div>')

def window():
    chat = ('<div class="msgs">'
            '<div class="u">把首屏按钮改成深色，hover 时稍微亮一点</div>'
            '<div class="a">好的，已经修改 <span class="dim">src/components/Hero.tsx</span>：'
            '<ul><li>主按钮背景改为 <code>#1f2937</code>，文字改为白色</li><li>hover 时背景提亮到 <code>#374151</code>，加 150ms 过渡</li>'
            '<li>同步更新了深色模式下的边框颜色</li></ul>本地预览已确认按钮对比度满足 WCAG AA。</div></div>'
            + band() +
            '<div class="prompt">回复…</div>')
    return ('<div class="card win"><div class="bar0"><span class="dot" style="background:#ff5f57"></span>'
            '<span class="dot" style="background:#febc2e"></span><span class="dot" style="background:#28c840"></span>'
            '<span class="b" style="margin-left:12px">落地页改版</span><span class="btn dim" style="margin-left:6px">website</span></div>'
            f'<div class="main"><div class="chat">{chat}</div><div class="side">{pane_sessions()}</div></div></div>')

os.makedirs(OUT, exist_ok=True)
page(f'<div class="stage">{window()}<div class="float">{notification()}</div></div>', 1488, 940, "overview")
page(notification(), 448, 140, "notification")
page(band(), 808, 150, "band")
page(f'<div class="card">{pane_sessions()}</div>', 488, 600, "pane-sessions")
page(f'<div class="card">{pane_usage()}</div>', 488, 762, "pane-usage")
