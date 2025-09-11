// recorder-processor.js (replace existing file with this)
class RecorderProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this._buffers = [];           // collected Float32 parts (each entry = [ch0Block, ch1Block, ...])
    this._sampleCounter = 0;      // absolute sample index since last reset
    this._armed = false;
    this._startSample = 0;
    this._endSample = 0;

    this.port.onmessage = (e) => {
      const d = e.data || {};
      if (d.cmd === 'reset') {
        this._buffers = [];
        this._sampleCounter = 0;
        this._armed = false;
        this._startSample = 0;
        this._endSample = 0;
        return;
      }
      if (d.cmd === 'arm') {
        // arm with a startSample (relative to the next sample after reset) and lengthSamples
        this._startSample = Number(d.startSample) || 0;
        const length = Number(d.lengthSamples) || 0;
        this._endSample = this._startSample + length;
        this._armed = true;
        // clear any prior buffers (fresh capture)
        this._buffers = [];
        return;
      }
      if (d.cmd === 'dump') {
        // explicit dump request (keeps backward compatibility)
        const numBlocks = this._buffers.length;
        if (!numBlocks) {
          this.port.postMessage({ cmd: 'dump', channels: [], length: 0, sampleRate: globalThis.sampleRate });
          this._buffers = [];
          return;
        }
        const numCh = this._buffers[0].length;
        const frames = this._buffers.reduce((s, b) => s + b[0].length, 0);
        const chans = Array.from({ length: numCh }, () => new Float32Array(frames));
        let offset = 0;
        for (const block of this._buffers) {
          for (let ch = 0; ch < numCh; ch++) {
            chans[ch].set(block[ch], offset);
          }
          offset += block[0].length;
        }
        this.port.postMessage({ cmd: 'dump', channels: chans, length: frames, sampleRate: globalThis.sampleRate }, chans.map(c => c.buffer));
        this._buffers = [];
        return;
      }
    };
  }

  process(inputs) {
    const input = inputs[0];
    // typical block length (usually 128 frames but don't assume)
    const blockLen = (input && input[0]) ? input[0].length : 128;
    const blockStart = this._sampleCounter;
    const blockEnd = blockStart + blockLen;

    if (input && input.length && this._armed) {
      // check overlap of [blockStart, blockEnd) with [start, end)
      const s = Math.max(blockStart, this._startSample);
      const e = Math.min(blockEnd, this._endSample);
      if (e > s) {
        const copyStart = s - blockStart;
        const copyLen = e - s;
        // copy each channel slice
        const blockCopy = input.map(ch => {
          // slice and create a new Float32Array
          return new Float32Array(ch.subarray(copyStart, copyStart + copyLen));
        });
        this._buffers.push(blockCopy);
      }
    }

    this._sampleCounter += blockLen;

    // if armed and we've reached or passed the end sample, auto-dump and clear armed
    if (this._armed && this._sampleCounter >= this._endSample) {
      // Pack recorded blocks into transferable arrays (same as dump code)
      const numBlocks = this._buffers.length;
      if (numBlocks === 0) {
        this.port.postMessage({ cmd: 'dump', channels: [], length: 0, sampleRate: globalThis.sampleRate });
        this._buffers = [];
      } else {
        const numCh = this._buffers[0].length;
        const frames = this._buffers.reduce((s, b) => s + b[0].length, 0);
        const chans = Array.from({ length: numCh }, () => new Float32Array(frames));
        let offset = 0;
        for (const block of this._buffers) {
          for (let ch = 0; ch < numCh; ch++) {
            chans[ch].set(block[ch], offset);
          }
          offset += block[0].length;
        }
        this.port.postMessage({ cmd: 'dump', channels: chans, length: frames, sampleRate: globalThis.sampleRate }, chans.map(c => c.buffer));
        this._buffers = [];
      }
      this._armed = false;
    }

    return true;
  }
}

registerProcessor('recorder-processor', RecorderProcessor);
