"""Generate deterministic log fixtures for tests/log-toolkit.test.mjs.

The fixtures are plain UTF-8 text; this script exists so they can be rebuilt and
reviewed instead of living as unexplained blobs. Paths are __file__-relative, so
the script works from any working directory.

Usage:
    python tests/_make_log_fixtures.py
"""

import os

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "fixtures", "log")


def stamp(seconds, hour=10, minute=0):
    return "2026-11-01T%02d:%02d:%02d.000Z" % (hour, minute, seconds)


# 30 lines: 6 error, 6 warn, 12 info, 5 debug, 1 unclassified.
# Lines 9 and 11 are identical after timestamp/数字 normalization (topMessages dedupe).
# Lines 12 and 20 use Chinese level words; line 23 carries a hex id; line 21 has no level.
SAMPLE = [
    "[INFO] service start pid=1001",
    "[INFO] config loaded from app.json",
    "[DEBUG] cache warmup begin",
    "[DEBUG] cache warmup done items=32",
    "[INFO] listening on port 8080",
    "[WARN] slow query detected in 120 ms",
    "[INFO] GET /health 200 3ms",
    "[INFO] GET /api/orders 200 45ms",
    "[ERROR] failed to connect to upstream db timeout after 3000 ms",
    "[WARN] retrying upstream connection attempt=1",
    "[ERROR] failed to connect to upstream db timeout after 3000 ms",
    "[信息] 缓存命中，使用降级数据",
    "[DEBUG] retry queue size=0",
    "[WARN] upstream latency spike p99=2400 ms",
    "[INFO] GET /api/users 200 12ms",
    "[ERROR] payment gateway rejected order=8821 code=E42",
    "[INFO] POST /api/orders 201 88ms",
    "[DEBUG] db pool stats active=4 idle=6",
    "[WARN] disk usage 81 percent on /var",
    "[INFO] 警告：队列积压已恢复正常",
    "response with no level marker",
    "[INFO] GET /api/orders/8821 500 210ms",
    "[ERROR] unhandled exception in worker-3 at 0xdeadbeef",
    "[INFO] worker-3 restart scheduled",
    "[DEBUG] heartbeat tick",
    "[WARNING] rate limit hit client=10.0.0.7",
    "[INFO] GET /healthz 200 2ms",
    "[ERROR] background job failed after 3 attempts",
    "[FATAL] out of memory, aborting",
    "[INFO] shutdown complete",
]


def write(name, text):
    path = os.path.join(OUT, name)
    with open(path, "w", encoding="utf-8", newline="\n") as handle:
        handle.write(text)
    return path, len(text.encode("utf-8"))


def main():
    os.makedirs(OUT, exist_ok=True)
    written = []

    # sample.log: the canonical 30-line fixture used by smoke.json and most tests.
    sample = "".join("%s %s\n" % (stamp(i), line) for i, line in enumerate(SAMPLE))
    written.append(write("sample.log", sample))

    # empty.log: zero-byte file (scan/grep must still answer cleanly).
    written.append(write("empty.log", ""))

    # longline.log: the needle sits past the 2000-char output cap, so a match proves
    # that matching runs on the raw line while the answer stays truncated.
    long_line = "%s [ERROR] %s needle" % (stamp(0, hour=10, minute=5), "x" * 3000)
    short_line = "%s [INFO] tail line after long line" % stamp(1, hour=10, minute=5)
    written.append(write("longline.log", "%s\n%s\n" % (long_line, short_line)))

    # big.log: 60 wide lines (~1850 chars each) to exercise the ~16 KB answer cap.
    big = "".join(
        "2026-11-01T11:00:00.000Z [WARN] spam payload index=%d %s\n" % (i, "z" * 1800)
        for i in range(1, 61)
    )
    written.append(write("big.log", big))

    # stream.log: 150 lines; only the tail 100 lines contain ERROR lines 120 and 150,
    # which is what tail:true/tail:false must distinguish.
    stream = []
    for i in range(1, 151):
        minute, second = divmod(i, 60)
        level, text = ("ERROR", "heartbeat lost") if i in (120, 150) else ("INFO", "heartbeat")
        stream.append("2026-11-01T09:%02d:%02d.000Z [%s] %s i=%d\n" % (minute, second, level, text, i))
    written.append(write("stream.log", "".join(stream)))

    for path, size in written:
        print("%-34s %7d B" % (os.path.relpath(path, HERE), size))


if __name__ == "__main__":
    main()
