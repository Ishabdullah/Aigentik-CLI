// trades.js — canonical subcontractor trade taxonomy and normalization.
// Kept as its own module (no dependencies) rather than living in
// contacts.js or subcontractor-form.js, since both of those need it and
// putting it in either would create a circular import between them.

const TRADES = {
  general_remodeling: ['general remodeling', 'general contractor', 'general contracting', 'remodeling', 'renovation'],
  plumbing: ['plumbing', 'plumber'],
  electrical: ['electrical', 'electrician'],
  hvac: ['hvac', 'heating', 'cooling', 'air conditioning'],
  painting: ['painting', 'painter'],
  roofing: ['roofing', 'roofer'],
  flooring: ['flooring', 'floor installation'],
  drywall: ['drywall', 'sheetrock', 'taping'],
  framing: ['framing', 'carpentry', 'carpenter'],
  concrete: ['concrete', 'masonry', 'mason'],
  tile: ['tile', 'tiling'],
  landscaping: ['landscaping', 'landscaper', 'lawn care'],
  demolition: ['demolition', 'demo'],
  excavation: ['excavation', 'excavating', 'grading'],
  windows_doors: ['window installation', 'windows and doors', 'window', 'door installation'],
  insulation: ['insulation'],
  cleaning: ['cleaning', 'debris removal', 'junk removal']
};

// Match freeform trade text (e.g. "General Remodeling", "electrician",
// "I do painting and drywall") to a single canonical trade slug —
// substring match against known synonyms, longest synonym wins so a more
// specific phrase beats a shorter one it happens to contain.
function normalizeTrade(raw) {
  if (!raw) return null;
  const text = raw.toLowerCase().trim();
  let best = null;
  let bestLen = 0;
  for (const [slug, synonyms] of Object.entries(TRADES)) {
    for (const syn of synonyms) {
      if (text.includes(syn) && syn.length > bestLen) {
        best = slug;
        bestLen = syn.length;
      }
    }
  }
  return best;
}

export { TRADES, normalizeTrade };
