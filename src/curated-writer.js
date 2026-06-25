// CuratedWriter — normalized event sink. Writes per-day, per-stream JSONL files that
// DuckDB can read directly (read_json_auto) or convert to Parquet. Plain JSONL (not zst)
// so DuckDB can scan without a decompress step; convert to Parquet in a later batch job.
const fs = require('fs');
const path = require('path');

class CuratedWriter {
  constructor(dir) {
    this.dir = dir;
    this.streams = new Map(); // name -> { day, fd }
    this.counts = {};
    fs.mkdirSync(dir, { recursive: true });
  }

  _day(d = new Date()) {
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}`;
  }

  _fd(name) {
    const day = this._day();
    const cur = this.streams.get(name);
    if (cur && cur.day === day) return cur.fd;
    if (cur) try { fs.closeSync(cur.fd); } catch {}
    const fp = path.join(this.dir, `${name}-${day}.jsonl`);
    const fd = fs.openSync(fp, 'a');
    this.streams.set(name, { day, fd });
    return fd;
  }

  write(name, obj) {
    const fd = this._fd(name);
    fs.writeSync(fd, JSON.stringify(obj) + '\n');
    this.counts[name] = (this.counts[name] || 0) + 1;
  }

  stats() { return { ...this.counts }; }

  close() {
    for (const { fd } of this.streams.values()) { try { fs.closeSync(fd); } catch {} }
  }
}

module.exports = { CuratedWriter };
