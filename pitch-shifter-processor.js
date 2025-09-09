// pitch-shifter-processor.js

// This import path assumes pitch-shifter.js (the Emscripten glue code) is in the same directory.
import Module from './pitch-shifter.js';

class PitchShifterProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super(options);

    this.wasmModule = null;
    this.soundtouch = null;
    this.inputBufferPtr = 0;
    this.outputBufferPtr = 0;

    // Fixed-size buffers for interacting with WASM. 4096 frames is a safe size.
    this.wasmInputBuffer = new Float32Array(4096);
    this.wasmOutputBuffer = new Float32Array(4096);

    this.isReady = false;

    // Load and initialize the WebAssembly module
    this.initWasm();

    this.port.onmessage = (event) => {
      if (event.data.type === 'setPitch') {
        const pitchFactor = event.data.value;
        if (this.isReady && this.soundtouch) {
          this._configure_soundtouch(this.soundtouch, 1, sampleRate, pitchFactor);
        }
      }
    };
  }

  async initWasm() {
    this.wasmModule = await Module();

    // Exported C++ functions wrapped for JS use
    this._create_soundtouch_instance = this.wasmModule.cwrap('create_soundtouch_instance', 'number', []);
    this._configure_soundtouch = this.wasmModule.cwrap('configure_soundtouch', null, ['number', 'number', 'number', 'number']);
    this._process_audio = this.wasmModule.cwrap('process_audio', null, ['number', 'number', 'number']);
    this._receive_audio = this.wasmModule.cwrap('receive_audio', 'number', ['number', 'number', 'number']);
    this._clear_soundtouch = this.wasmModule.cwrap('clear_soundtouch', null, ['number']);

    // Allocate memory inside the WASM module for our buffers
    this.inputBufferPtr = this.wasmModule._malloc(this.wasmInputBuffer.byteLength);
    this.outputBufferPtr = this.wasmModule._malloc(this.wasmOutputBuffer.byteLength);

    // Create a SoundTouch instance
    this.soundtouch = this._create_soundtouch_instance();

    // Configure with default values (mono, context's sample rate, no pitch shift)
    this._configure_soundtouch(this.soundtouch, 1, sampleRate, 1.0);

    this.isReady = true;
    console.log('Pitch Shifter WASM module ready.');
  }

  process(inputs, outputs, parameters) {
    // Wait until the WASM module is fully initialized
    if (!this.isReady || !this.soundtouch) {
      return true;
    }

    const input = inputs[0];
    const output = outputs[0];
    const inputChannel = input[0]; // Assuming mono input for simplicity

    if (!inputChannel) {
        return true;
    }

    // 1. Copy input data into our buffer
    this.wasmInputBuffer.set(inputChannel);

    // 2. Copy data from JS buffer to the allocated memory space in WASM
    this.wasmModule.HEAPF32.set(this.wasmInputBuffer, this.inputBufferPtr / 4);

    // 3. Process the audio chunk using SoundTouch
    this._process_audio(this.soundtouch, this.inputBufferPtr, inputChannel.length);

    // 4. Receive the processed (pitch-shifted) audio from SoundTouch
    const framesReceived = this._receive_audio(this.soundtouch, this.outputBufferPtr, output[0].length);

    if (framesReceived > 0) {
      // 5. Copy data from WASM memory back to our JS buffer
      const processedData = this.wasmModule.HEAPF32.subarray(this.outputBufferPtr / 4, this.outputBufferPtr / 4 + framesReceived);

      // 6. Write the processed data to all output channels
      for (let channel = 0; channel < output.length; channel++) {
        output[channel].set(processedData);
      }
    }

    return true;
  }
}

registerProcessor('pitch-shifter-processor', PitchShifterProcessor);
