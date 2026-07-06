// Microphone capture worklet: accumulates mono samples into fixed-size blocks
// and posts each block to the main thread for Goertzel decoding.
const BLOCK = 512;

class Capture extends AudioWorkletProcessor {
  constructor() {
    super();
    this._buf = new Float32Array(BLOCK);
    this._n = 0;
  }

  process(inputs) {
    const input = inputs[0];
    if (input && input[0]) {
      const ch = input[0];
      for (let i = 0; i < ch.length; i++) {
        this._buf[this._n++] = ch[i];
        if (this._n === BLOCK) {
          const out = this._buf.slice();
          this.port.postMessage(out, [out.buffer]);
          this._n = 0;
        }
      }
    }
    return true;
  }
}

registerProcessor("capture", Capture);
