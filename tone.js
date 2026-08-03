// tone.js — Aigentik tone detection and matching
// Detects the tone of incoming messages and passes to llama for matched replies

import * as llama from './llama.js';
import log from './logger.js';

// Detect tone of a message using llama
async function detectTone(text) {
  if (!text || text.trim().length < 5) return 'neutral';
  try {
    const tone = await llama.detectTone(text);
    log.debug('tone', `Detected tone: ${tone}`, { preview: text.substring(0, 50) });
    return tone;
  } catch (e) {
    log.warn('tone', 'Tone detection failed, using neutral', { error: e.message });
    return 'neutral';
  }
}

export { detectTone };