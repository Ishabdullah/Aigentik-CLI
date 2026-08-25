// trades.js — canonical subcontractor trade taxonomy and normalization.
// Kept as its own module (no dependencies) rather than living in
// contacts.js or subcontractor-form.js, since both of those need it and
// putting it in either would create a circular import between them.

const TRADES = {
  general_remodeling: ['general remodeling', 'general contractor', 'general contracting', 'remodeling', 'renovation', 'home improvement', 'remodeler', 'general builder'],
  roofing: ['roofing', 'roofer', 'roof replacement', 'shingle roofing', 'flat roofing', 'roof repair', 'roof installer'],
  siding: ['siding', 'siding installer', 'vinyl siding', 'hardie board', 'james hardie', 'fiber cement', 'cedar siding'],
  windows: ['window installation', 'window replacement', 'windows', 'window installer'],
  doors: ['door installation', 'door replacement', 'doors', 'door installer', 'entry doors'],
  windows_doors: ['windows and doors', 'window and door'],
  gutters: ['gutters', 'gutter installation', 'seamless gutters', 'gutter guard', 'gutter repair'],
  painting: ['painting', 'painter', 'interior painting', 'exterior painting', 'cabinet painting', 'spray painting'],
  drywall: ['drywall', 'sheetrock', 'taping', 'spackling', 'plaster', 'drywall finisher', 'hanging drywall'],
  framing: ['framing', 'rough carpentry', 'framer', 'structural framing', 'wood framing', 'carpentry', 'carpenter'],
  finish_carpentry: ['finish carpentry', 'trim carpentry', 'finish carpenter', 'trim carpenter', 'custom trim', 'millwork', 'crown molding', 'baseboard', 'wainscoting'],
  flooring: ['flooring', 'floor installation', 'hardwood flooring', 'vinyl plank', 'lvp', 'laminate flooring', 'floor installer'],
  tile: ['tile', 'tiling', 'tile installer', 'tile setter', 'ceramic tile', 'porcelain tile', 'backsplash', 'tile shower'],
  cabinets: ['cabinets', 'cabinet installation', 'cabinet installer', 'cabinet maker', 'kitchen cabinets', 'cabinetry'],
  countertops: ['countertops', 'countertop installation', 'granite installer', 'quartz countertops', 'stone fabricator', 'solid surface'],
  plumbing: ['plumbing', 'plumber', 'master plumber', 'licensed plumber', 'pipefitter', 'residential plumbing'],
  electrical: ['electrical', 'electrician', 'licensed electrician', 'master electrician', 'electrical contractor', 'wiring'],
  hvac: ['hvac', 'heating', 'cooling', 'air conditioning', 'heat pumps', 'mini-split', 'furnace', 'boiler', 'ductwork'],
  insulation: ['insulation', 'insulation contractor', 'spray foam', 'blown-in insulation', 'batt insulation', 'attic insulation'],
  masonry: ['masonry', 'mason', 'bricklayer', 'brickwork', 'stonework', 'stone veneer', 'chimney repair', 'repointing', 'paving'],
  concrete: ['concrete', 'concrete contractor', 'concrete finisher', 'flatwork', 'stamped concrete', 'footings', 'foundation repair'],
  decks: ['decks', 'deck builder', 'deck building', 'composite decking', 'trex', 'deck repair', 'wood decks'],
  porches: ['porches', 'porch builder', 'screened porch', 'covered porch', 'portico'],
  fencing: ['fencing', 'fence installation', 'fence builder', 'privacy fence', 'vinyl fence', 'wood fence', 'chain link'],
  excavation: ['excavation', 'excavating', 'grading', 'earthwork', 'site prep', 'trenching', 'backhoe'],
  landscaping: ['landscaping', 'landscaper', 'lawn care', 'hardscaping', 'yard work', 'landscape design'],
  demolition: ['demolition', 'demo', 'interior demolition', 'selective demo', 'tear out'],
  water_damage_restoration: ['water damage restoration', 'water damage', 'water mitigation', 'flood cleanup', 'water extraction', 'structural drying', 'mitigation'],
  fire_smoke_restoration: ['fire damage restoration', 'fire restoration', 'smoke restoration', 'smoke damage', 'soot cleanup', 'fire and smoke'],
  mold_remediation: ['mold remediation', 'mold removal', 'mold cleanup', 'mold mitigation', 'mold treatment'],
  property_cleanup: ['property cleanup', 'cleanup', 'debris removal', 'junk removal', 'post construction cleaning', 'site cleanup'],
  pressure_washing: ['pressure washing', 'power washing', 'soft washing', 'roof cleaning', 'exterior cleaning'],
  cleaning: ['cleaning', 'maid service', 'janitorial'],
  other_construction: ['construction', 'handyman', 'general labor', 'tradesman', 'subcontractor']
};

const TRADE_DISPLAY_NAMES = {
  general_remodeling: 'General Remodeling',
  roofing: 'Roofing',
  siding: 'Siding',
  windows: 'Windows',
  doors: 'Doors',
  windows_doors: 'Windows & Doors',
  gutters: 'Gutters',
  painting: 'Painting',
  drywall: 'Drywall & Plaster',
  framing: 'Framing & Rough Carpentry',
  finish_carpentry: 'Finish Carpentry & Trim',
  flooring: 'Flooring',
  tile: 'Tile & Stone',
  cabinets: 'Cabinet Installation',
  countertops: 'Countertops',
  plumbing: 'Plumbing',
  electrical: 'Electrical',
  hvac: 'HVAC / Heating & Cooling',
  insulation: 'Insulation',
  masonry: 'Masonry & Stonework',
  concrete: 'Concrete & Foundations',
  decks: 'Decks & Decking',
  porches: 'Porches & Porticos',
  fencing: 'Fencing',
  excavation: 'Excavation & Site Prep',
  landscaping: 'Landscaping & Hardscaping',
  demolition: 'Demolition & Tear-out',
  water_damage_restoration: 'Water Damage Restoration',
  fire_smoke_restoration: 'Fire & Smoke Restoration',
  mold_remediation: 'Mold Remediation',
  property_cleanup: 'Property Cleanup & Hauling',
  pressure_washing: 'Pressure & Soft Washing',
  cleaning: 'Cleaning Services',
  other_construction: 'General Residential Construction'
};

const TRADE_SPECIFIC_QUESTIONS = {
  roofing: [
    'What roofing systems do you work with (architectural shingles, flat/rubber, metal)?',
    'Do you handle complete tear-offs and structural decking repairs?',
    'Do you offer emergency tarping or storm damage response?',
    'Do you hold manufacturer certifications (e.g. GAF, Owens Corning, CertainTeed)?',
    'What is your typical crew size and roof square capacity per day?'
  ],
  painting: [
    'Do you handle both interior and exterior residential painting?',
    'What is your standard preparation process (scraping, sanding, priming, caulking)?',
    'Do you offer cabinet spray refinishing or fine finish woodwork painting?',
    'What is your typical crew size and project turnaround time?'
  ],
  electrical: [
    'Do you handle residential service upgrades, panel replacements, and remodeling rough-in/finish?',
    'Do you install EV chargers, subpanels, and standby generators?',
    'Do you hold a current Connecticut E-1 or E-2 electrical license?',
    'Do you pull permits and coordinate with local building inspectors?'
  ],
  plumbing: [
    'What types of residential remodeling and service work do you specialize in?',
    'Do you install water heaters (tankless and standard), fixtures, and repiping?',
    'Do you provide emergency service or same-day diagnostics?',
    'Do you hold a current Connecticut P-1 or P-2 plumbing license?'
  ],
  hvac: [
    'What heating and cooling systems do you install and service (furnaces, boilers, AC, heat pumps, mini-splits)?',
    'Do you design and install ductwork or ductless configurations?',
    'Do you provide seasonal maintenance and emergency diagnostics?',
    'Do you hold a current Connecticut S-1/S-2 or D-1/D-2 HVAC license?'
  ],
  water_damage_restoration: [
    'Do you provide 24/7 emergency water extraction and structural drying?',
    'Do you hold IICRC certifications (such as WRT or ASD)?',
    'What commercial drying equipment inventory do you maintain (LGR dehumidifiers, air movers)?',
    'Do you have experience working directly with insurance adjusters and Xactimate scopes?'
  ],
  mold_remediation: [
    'What containment protocols, negative air HEPA machines, and antimicrobial treatments do you use?',
    'Do you work with independent third-party industrial hygienists for post-remediation clearance testing?',
    'Do you have IICRC AMRT or equivalent mold remediation certification?'
  ],
  fire_smoke_restoration: [
    'Do you handle structural soot cleaning, thermal fogging/hydroxyl odor removal, and pack-outs?',
    'Do you have experience with fire damage rebuilds and structural framing repairs?',
    'Do you hold IICRC FSRT or related fire restoration certifications?'
  ],
  siding: [
    'What siding materials do you install (vinyl, James Hardie/fiber cement, cedar, LP SmartSide)?',
    'Do you handle aluminum trim capping, soffit, fascia, and weather-resistive barriers?',
    'What is your typical crew size for full siding replacements?'
  ],
  gutters: [
    'Do you fabricate 5-inch and 6-inch seamless gutters on-site?',
    'Do you install gutter protection systems and underground drainage extensions?'
  ],
  framing: [
    'Do you specialize in residential additions, rough framing, and load-bearing beam installations?',
    'Are you comfortable working from architectural blueprints and engineering specifications?'
  ],
  finish_carpentry: [
    'What scope of finish woodwork do you specialize in (interior doors, crown molding, custom built-ins, stair trim)?',
    'Do you provide your own precision miter saws and specialized finish tools?'
  ],
  flooring: [
    'What flooring types do you install (hardwood nail-down/glue-down, LVP, engineered wood, laminate)?',
    'Do you perform subfloor prep, leveling, and moisture testing prior to installation?'
  ],
  tile: [
    'Do you build custom waterproof shower enclosures using systems like Schluter-Kerdi or Wedi?',
    'What types of tile do you install (large format, natural stone, ceramic, mosaic backsplashes)?',
    'Do you install radiant in-floor heating systems?'
  ],
  cabinets: [
    'Do you install pre-assembled and custom kitchen/bath cabinetry?',
    'Do you handle trim scribing, crown molding integration, and hardware installation?'
  ],
  countertops: [
    'Do you handle laser digital templating, fabrication, and installation of quartz, granite, and marble?',
    'What is your typical turnaround time from template to install?'
  ],
  masonry: [
    'What masonry work do you perform (brick, natural stone veneer, chimney repointing, block foundations, patios)?',
    'Do you provide structural stone and brick restoration?'
  ],
  concrete: [
    'What concrete projects do you handle (slabs, frost footings, walkways, stamped patios, foundation repairs)?',
    'Do you provide your own formwork and finishing equipment?'
  ],
  decks: [
    'What decking materials do you work with (Trex, TimberTech, cedar, pressure-treated)?',
    'Do you handle excavation, sonotube footings, framing, and code-compliant railing systems?'
  ],
  porches: [
    'Do you build custom screened porches, covered front porches, and porticos from the foundation up?'
  ],
  fencing: [
    'What fencing systems do you install (vinyl, wood privacy, chain link, ornamental aluminum)?'
  ],
  excavation: [
    'What earthwork equipment do you operate (mini-excavator, skid steer, dump trailers)?',
    'Do you handle utility trenching, foundation dig-outs, and site grading?'
  ],
  landscaping: [
    'Do you focus on hardscaping (paver patios, retaining walls, walkways) or softscape plantings/grading?'
  ],
  demolition: [
    'Do you handle interior selective gut-outs, dust containment, and debris disposal haul-away?'
  ],
  pressure_washing: [
    'Do you offer low-pressure soft washing for siding/roofs and high-pressure washing for flat concrete/brick?'
  ],
  property_cleanup: [
    'Do you handle post-construction site sweeps, junk removal, and dumpster loading?'
  ],
  general_remodeling: [
    'What residential remodeling projects do you focus on (kitchens, bathrooms, basements, whole-house renovations)?',
    'Do you manage your own specialized trades or coordinate with licensed subcontractors?'
  ]
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

// Find all matching trades from text (for contractors who perform multiple trades)
function extractAllTrades(raw) {
  if (!raw) return [];
  const text = raw.toLowerCase().trim();
  const matched = new Set();
  for (const [slug, synonyms] of Object.entries(TRADES)) {
    for (const syn of synonyms) {
      if (text.includes(syn)) {
        matched.add(slug);
        break;
      }
    }
  }
  return Array.from(matched);
}

function getTradeDisplayName(slug) {
  return TRADE_DISPLAY_NAMES[slug] || (slug ? slug.replace(/_/g, ' ').replace(/\b\w/g, l => l.toUpperCase()) : 'Unknown Trade');
}

function getTradeSpecificQuestions(slug) {
  return TRADE_SPECIFIC_QUESTIONS[slug] || [
    'What specific residential projects are you most experienced with?',
    'What is your typical crew size and project turnaround time?'
  ];
}

function isRecognizedTrade(slugOrRaw) {
  if (!slugOrRaw) return false;
  return Boolean(TRADES[slugOrRaw] || normalizeTrade(slugOrRaw));
}

function getAllTradeSlugs() {
  return Object.keys(TRADES);
}

export {
  TRADES,
  TRADE_DISPLAY_NAMES,
  TRADE_SPECIFIC_QUESTIONS,
  normalizeTrade,
  extractAllTrades,
  getTradeDisplayName,
  getTradeSpecificQuestions,
  isRecognizedTrade,
  getAllTradeSlugs
};
