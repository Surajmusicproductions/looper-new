#include "SoundTouch.h"
#include <emscripten.h>
#include <cstdint>

// Use the soundtouch namespace
using namespace soundtouch;

// C-style functions that Emscripten can easily export
extern "C" {

  // Creates a new SoundTouch instance and returns a pointer to it
  EMSCRIPTEN_KEEPALIVE
  SoundTouch* create_soundtouch_instance() {
    return new SoundTouch();
  }

  // Configures the SoundTouch instance
  EMSCRIPTEN_KEEPALIVE
  void configure_soundtouch(SoundTouch* st_ptr, int channels, int sample_rate, float pitch_factor) {
    if (!st_ptr) return;
    st_ptr->setSampleRate(sample_rate);
    st_ptr->setChannels(channels);
    st_ptr->setPitch(pitch_factor); // Use setPitch for semitone-independent shifting
    st_ptr->setRate(1.0); // Ensure playback rate is not changed
    st_ptr->setTempo(1.0); // Ensure tempo is not changed
  }

  // Puts audio samples into the SoundTouch processing pipeline
  // The input buffer is identified by its memory offset
  EMSCRIPTEN_KEEPALIVE
  void process_audio(SoundTouch* st_ptr, float* input_buffer_ptr, int num_frames) {
    if (!st_ptr) return;
    st_ptr->putSamples(input_buffer_ptr, num_frames);
  }

  // Receives processed (pitch-shifted) samples from SoundTouch
  // The output buffer is identified by its memory offset
  EMSCRIPTEN_KEEPALIVE
  int receive_audio(SoundTouch* st_ptr, float* output_buffer_ptr, int max_frames) {
    if (!st_ptr) return 0;
    return st_ptr->receiveSamples(output_buffer_ptr, max_frames);
  }

  // Clears the internal buffers of the SoundTouch instance
  EMSCRIPTEN_KEEPALIVE
  void clear_soundtouch(SoundTouch* st_ptr) {
    if (!st_ptr) return;
    st_ptr->clear();
  }
  
  // Destroys the SoundTouch instance to free up memory
  EMSCRIPTEN_KEEPALIVE
  void destroy_soundtouch_instance(SoundTouch* st_ptr) {
    if (st_ptr) {
      delete st_ptr;
    }
  }
}
