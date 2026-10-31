import os, random, csv
from docx import Document
from docx.shared import Pt
from openpyxl import Workbook

root = os.path.join("upp", "tests", "fixtures", "doc")
os.makedirs(root, exist_ok=True)

# ---------------- sample.docx
d = Document()
d.add_heading("UPP 文档工具测试", level=1)
d.add_paragraph("这是一段用于验证 docx 解析的中文段落，包含 UPP、docx、digest 等关键词。")
d.add_heading("背景与目标", level=2)
d.add_paragraph("Doc Toolkit 在本地把文档拆成结构摘要，避免把整份文件放进上下文。")
d.add_heading("数据与结论", level=2)
d.add_paragraph("示例表格如下：")
t = d.add_table(rows=3, cols=3)
for r, row in enumerate([["区域", "销量", "备注"], ["华东", "1200", "同比增长"], ["华南", "980", "稳定"]]):
    for c, val in enumerate(row):
        t.cell(r, c).text = val
d.add_paragraph("结论：先 digest 再按需 extract，可显著降低 token 消耗。")
d.save(os.path.join(root, "sample.docx"))

# ---------------- sample.xlsx
wb = Workbook()
ws = wb.active
ws.title = "Sales"
ws.append(["Date", "Region", "Product", "Units", "Revenue"])
rows = [
    ("2026-01-05", "East", "Widget", 12, 1440.0),
    ("2026-01-06", "South", "Widget", 8, 960.0),
    ("2026-01-07", "North", "Gadget", 5, 1250.0),
    ("2026-01-08", "East", "Gadget", 9, 2250.0),
    ("2026-01-09", "West", "Widget", 21, 2520.0),
    ("2026-01-10", "South", "Gizmo", 3, 540.0),
    ("2026-01-11", "North", "Widget", 17, 2040.0),
    ("2026-01-12", "East", "Gizmo", 6, 1080.0),
    ("2026-01-13", "West", "Gadget", 4, 1000.0),
    ("2026-01-14", "South", "Widget", 13, 1560.0),
]
for r in rows:
    ws.append(list(r))
notes = wb.create_sheet("Notes")
notes.append(["Owner", "Note"])
notes.append(["Racoon", "样本数据，仅用于 UPP 测试"])
wb.save(os.path.join(root, "sample.xlsx"))

# ---------------- sample.csv
with open(os.path.join(root, "sample.csv"), "w", encoding="utf-8", newline="") as fh:
    w = csv.writer(fh)
    w.writerow(["id", "name", "score", "note"])
    w.writerow([1, "alpha", 91.5, "first, with comma"])
    w.writerow([2, "beta", 78, 'has "quoted" text'])
    w.writerow([3, "gamma", 88.25, ""])
    w.writerow([4, "delta", 65, "low"])
    w.writerow([5, "epsilon", 99, "top"])

# ---------------- sample.html
html = """<!doctype html>
<html><head><title>Sample Scraped Page</title>
<style>body{font:14px}</style></head>
<body>
<h1>Market snapshot</h1>
<p>This page was saved locally, so the plugin can read it without network access.</p>
<p>Links: <a href="https://example.com/a">source A</a> and <a href="https://example.com/b">source B</a>.</p>
<img src="chart.png" alt="chart" />
<script>var tracking = {"secret": 1};</script>
</body></html>
"""
with open(os.path.join(root, "sample.html"), "w", encoding="utf-8") as fh:
    fh.write(html)

# ---------------- big fixtures (not committed; only for the savings measurement)
big = os.path.join("upp", "tests", ".tmp-big")
os.makedirs(big, exist_ok=True)
wbb = Workbook()
wsb = wbb.active
wsb.title = "Export"
wsb.append(["id", "date", "region", "product", "units", "revenue", "cost", "margin", "rep", "note"])
random.seed(7)
regions = ["East", "South", "North", "West"]
products = ["Widget", "Gadget", "Gizmo"]
for i in range(6000):
    units = random.randint(1, 40)
    revenue = round(units * random.uniform(90, 130), 2)
    cost = round(revenue * random.uniform(0.55, 0.8), 2)
    wsb.append([
        i + 1,
        f"2026-{random.randint(1,12):02d}-{random.randint(1,28):02d}",
        random.choice(regions),
        random.choice(products),
        units,
        revenue,
        cost,
        round(revenue - cost, 2),
        f"rep{random.randint(1,40):02d}",
        "auto-generated row for the local-first measurement" * 2,
    ])
wbb.save(os.path.join(big, "big.xlsx"))

db = Document()
db.add_heading("Annual operations report", level=1)
para = ("This paragraph is synthetic filler used to measure how a long document behaves "
        "when it is digested locally instead of being pasted into a model context. ")
for i in range(600):
    db.add_paragraph(f"Section {i % 40}: " + para * 2)
db.save(os.path.join(big, "big.docx"))

with open(os.path.join(big, "big.csv"), "w", encoding="utf-8", newline="") as fh:
    w = csv.writer(fh)
    w.writerow(["id", "region", "product", "units", "revenue", "cost", "margin", "note"])
    for i in range(20000):
        units = random.randint(1, 40)
        revenue = round(units * random.uniform(90, 130), 2)
        cost = round(revenue * random.uniform(0.55, 0.8), 2)
        w.writerow([i + 1, random.choice(regions), random.choice(products), units, revenue, cost,
                    round(revenue - cost, 2), "generated"])

print("fixtures:", sorted(os.listdir(root)))
print("big:", [(f, os.path.getsize(os.path.join(big, f))) for f in sorted(os.listdir(big))])
