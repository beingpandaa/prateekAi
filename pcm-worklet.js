class PCMRecorder extends AudioWorkletProcessor {
  constructor() { super(); this.samples = new Int16Array(Math.round(sampleRate / 10)); this.offset = 0; this.peak = 0; }
  process(inputs, outputs) {
    const channels = inputs[0];
    if (channels?.length) {
      for (let i = 0; i < channels[0].length; i++) {
        let value = 0; for (const channel of channels) value += channel[i] || 0;
        value = Math.max(-1, Math.min(1, value / channels.length));
        this.peak = Math.max(this.peak, Math.abs(value));
        this.samples[this.offset++] = Math.round(value < 0 ? value * 32768 : value * 32767);
        if (this.offset === this.samples.length) {
          this.port.postMessage({ pcm: this.samples.buffer, peak: this.peak }, [this.samples.buffer]);
          this.samples = new Int16Array(Math.round(sampleRate / 10)); this.offset = 0; this.peak = 0;
        }
      }
    }
    for (const output of outputs) for (const channel of output) channel.fill(0);
    return true;
  }
}
registerProcessor('pcm-recorder', PCMRecorder);
