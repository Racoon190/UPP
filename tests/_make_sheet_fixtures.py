"""Generate the Sheet Toolkit test fixtures (bundled python + openpyxl).

Run with the dsh bundled interpreter, e.g.
  "C:/Users/Administrator/.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/python/python.exe" \
      tests/_make_sheet_fixtures.py

Produces (relative to this script):
  fixtures/sheet/sample.xlsx  three sheets with a dirty "Data" table
  fixtures/sheet/large.csv    150 rows big enough to trip the output caps

The fixtures are deterministic: re-running this script regenerates byte-stable
workbooks (fixed zip timestamps come from openpyxl's default 1980 epoch).
"""
from __future__ import annotations

import datetime as dt
import pathlib

from openpyxl import Workbook

HERE = pathlib.Path(__file__).resolve().parent
OUT = HERE / "fixtures" / "sheet"


def build_sample(path: pathlib.Path) -> None:
    wb = Workbook()
    data = wb.active
    data.title = "Data"
    data.append(["Region", "Product", "Revenue"])
    data.append(["North", "Widget", 1200])
    data.append([" South ", "Widget", 800])
    data.append(["North", "Widget", 1200])
    data.append(["  ", " ", "  "])
    data.append(["East", "Gadget", 500])
    data.append(["South", "Gizmo", 300])

    notes = wb.create_sheet("Notes")
    notes.append(["Owner", "Note"])
    notes.append(["Racoon", "sample data for UPP smoke"])
    notes.append(["Lead", "sheet selection works"])

    dated = wb.create_sheet("Dated")
    dated.append(["Day", "Amount"])
    dated.append([dt.date(2026, 1, 5), 12.5])
    dated.append([dt.date(2026, 2, 10), 7.25])
    for cell in (dated["A2"], dated["A3"]):
        cell.number_format = "yyyy-mm-dd"

    wb.active = 0
    wb.save(path)


def build_large(path: pathlib.Path) -> None:
    header = ["id", "date", "region", "product", "units", "note"]
    lines = [",".join(header)]
    for i in range(1, 151):
        day = dt.date(2026, (i % 12) + 1, (i % 28) + 1).isoformat()
        region = "R%02d" % ((i % 12) + 1)
        product = "P%d" % ((i % 3) + 1)
        units = (i * 7) % 40
        note = "row %03d " % i + "x" * 180
        lines.append(",".join([str(i), day, region, product, str(units), note]))
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    build_sample(OUT / "sample.xlsx")
    build_large(OUT / "large.csv")
    print("wrote", (OUT / "sample.xlsx").as_posix(), (OUT / "sample.xlsx").stat().st_size, "bytes")
    print("wrote", (OUT / "large.csv").as_posix(), (OUT / "large.csv").stat().st_size, "bytes")


if __name__ == "__main__":
    main()
