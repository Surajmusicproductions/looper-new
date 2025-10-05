#include <vector>
#include <cmath>
#include <numeric>

// Required for Emscripten to export functions
#include <emscripten.h>

// This tells the C++ compiler to make the function linkable in a C-style,
// which is what Emscripten needs to find and export it.
extern "C" {

// EMSCRIPTEN_KEEPALIVE prevents Emscripten from removing this function during optimization,
// ensuring it's available for JavaScript to call.
EMSCRIPTEN_KEEPALIVE
float find_pitch(float* audio_buffer, int buffer_size, float sample_rate) {
    const float threshold = 0.15f;
    const float min_freq = 100.0f; // Minimum frequency for harmonica range
    const int max_lag = static_cast<int>(sample_rate / min_freq);

    std::vector<float> yin_buffer(max_lag, 0.0f);
    
    // 1. Difference function
    for (int tau = 1; tau < max_lag; ++tau) {
        float diff_sum = 0.0f;
        for (int i = 0; i < buffer_size - tau; ++i) {
            float delta = audio_buffer[i] - audio_buffer[i + tau];
            diff_sum += delta * delta;
        }
        yin_buffer[tau] = diff_sum;
    }

    // 2. Cumulative mean normalized difference
    float running_sum = 0.0f;
    yin_buffer[0] = 1.0f;
    for (int tau = 1; tau < max_lag; ++tau) {
        running_sum += yin_buffer[tau];
        if (running_sum > 0) {
            yin_buffer[tau] *= tau / running_sum;
        }
    }

    // 3. Absolute thresholding
    for (int tau = 1; tau < max_lag; ++tau) {
        if (yin_buffer[tau] < threshold) {
            int better_tau = tau;
            while (tau + 1 < max_lag && yin_buffer[tau + 1] < yin_buffer[tau]) {
                better_tau = ++tau;
            }

            // 4. Parabolic interpolation for better precision
            if (better_tau > 0 && better_tau < max_lag - 1) {
                float s0 = yin_buffer[better_tau - 1];
                float s1 = yin_buffer[better_tau];
                float s2 = yin_buffer[better_tau + 1];
                float divisor = 2 * s1 - s2 - s0;
                float adjustment = (divisor != 0) ? (s2 - s0) / (2 * divisor) : 0;
                return sample_rate / (static_cast<float>(better_tau) + adjustment);
            }
            return sample_rate / static_cast<float>(better_tau);
        }
    }

    // Return 0 if no pitch is found
    return 0.0f;
}

} // extern "C"
