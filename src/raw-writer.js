// RawWriter — append-only, hourly-rotated, zstd-compressed JSONL sink for raw frames.
// Spawns the `zstd` CLI and streams newline-delimited JSON into it. One file per UTC hour.
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

class RawWriter {
  constructor(dir) {
    this.dir = dir;
    this.curHour = null;
    this.proc = null;
    this.bytesIn = 0;
    this.lines = 0;
    fs.mkdirSync(dir, { recursive: true });
  }

  _hourKey(d = new Date()) {
    // UTC YYYYMMDD-HH
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}-${p(d.getUTCHours())}`;
  }

  _rotate() {
    const hk = this._hourKey();
    if (hk === this.curHour && this.proc && !this.proc.killed) return;
    if (this.proc) {
      try { this.proc.stdin.end(); } catch {}
    }
    this.curHour = hk;
    const outPath = path.join(this.dir, `frames-${hk}.jsonl.zst`);
    // append mode: -q quiet, -T0 multithread, write to file via shell redirection append.
    // zstd can't append to a .zst stream cleanly, so each rotation opens a fresh file;
    // if the file exists (restart mid-hour) we suffix with a part counter.
    let finalPath = outPath;
    let part = 1;
    while (fs.existsSync(finalPath)) {
      finalPath = path.join(this.dir, `frames-${hk}.part${part}.jsonl.zst`);
      part++;
    }
    const fd = fs.openSync(finalPath, 'w');
    this.proc = spawn('zstd', ['-q', '-3', '-T0', '-c'], { stdio: ['pipe', fd, 'inherit'] });
    this.proc.on('error', (e) => console.error('[raw-writer] zstd error:', e.message));
    this.curPath = finalPath;
  }

  write(obj) {
    this._rotate();
    const line = JSON.stringify(obj) + '\n';
    this.bytesIn += line.length;
    this.lines++;
    try {
      this.proc.stdin.write(line);
    } catch (e) {
      console.error('[raw-writer] write failed:', e.message);
    }
  }

  stats() {
    return { lines: this.lines, bytesIn: this.bytesIn, curPath: this.curPath };
  }

  close() {
    if (this.proc) {
      try { this.proc.stdin.end(); } catch {}
    }
  }
}

module.exports = { RawWriter };
