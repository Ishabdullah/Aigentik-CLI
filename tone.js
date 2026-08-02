// tone.js — Aigentik tone detection and matching
// Detects the tone of incoming messages and passes to llama for matched replies

import * as llama from './llama.js';
import log from './logger.js';

const VALID_TONES = ['formal', 'casual', 'urgent', 'friendly', 'aggressive', 'neutral', 'professional'];

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

// Get tone instruction string for prompts
function getToneInstruction(tone) {
  const instructions = {
    formal: 'Use formal, professional language with proper grammar.',
    casual: 'Use casual, relaxed language like you are texting a friend.',
    urgent: 'Be concise and direct. Acknowledge the urgency.',
    friendly: 'Be warm, friendly and conversational.',
    aggressive: 'Be firm but respectful. Do not match aggression, stay calm and professional.',
    neutral: 'Use clear, neutral language.',
    professional: 'Use professional business language.'
  };
  return instructions[tone] || instructions.neutral;
}

export { detectTone, getToneInstruction, VALID_TONES };