// recorder-processor.js
class RecorderProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this._buffers = []; // store blocks
    this.port.onmessage = (e) => {
      if (e.data?.cmd === 'reset') {
        this._buffers = [];
      }
      if (e.data?.cmd === 'dump') {
        // Pack recorded blocks into transferable arrays
        const numBlocks = this._buffers.length;
        if (!numBlocks) {
          this.port.postMessage({ cmd: 'dump', channels: [], length: 0, sampleRate: globalThis.sampleRate });
          // ensure buffers cleared (defensive)
          this._buffers = [];
          return;
        }
        const numCh = this._buffers[0].length;
        const frames = numBlocks * this._buffers[0][0].length;
        const chans = Array.from({ length: numCh }, () => new Float32Array(frames));

        let offset = 0;
        for (const block of this._buffers) {
          for (let ch = 0; ch < numCh; ch++) {
            chans[ch].set(block[ch], offset);
          }
          offset += block[0].length;
        }

        // send data back and then clear internal buffer store
        this.port.postMessage(
          {
            cmd: 'dump',
            channels: chans,
            length: frames,
            sampleRate: globalThis.sampleRate
          },
          chans.map(c => c.buffer)
        );
        // clear buffers so next recording starts fresh
        this._buffers = [];
      }
    };
  }

  process(inputs) {
    const input = inputs[0];
    if (input && input.length) {
      // copy each channel’s Float32Array
      const copy = input.map(ch => new Float32Array(ch));
      this._buffers.push(copy);
    }
    return true;
  }
}

registerProcessor('recorder-processor', RecorderProcessor);
