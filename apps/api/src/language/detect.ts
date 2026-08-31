import type { SpokenLanguage } from "@resqai/schema";

/**
 * Language detection for text channels.
 *
 * Script-based, and deliberately so. For text arriving over WhatsApp, SMS or
 * the web there is no recognition step and no audio to be uncertain about — the
 * Unicode block a character sits in is a fact, not an inference. That makes
 * detection on text channels far more reliable than anything achievable on
 * voice, which is one of the reasons M2 builds the text path first.
 *
 * Two honest limits, both surfaced rather than hidden:
 *
 *  1. **Devanagari is shared.** Hindi, Marathi, Maithili, Nepali, Konkani,
 *     Dogri, Bodo and Sanskrit all use it. Script identifies the block, not the
 *     language. We report the most probable language with a confidence that
 *     reflects the ambiguity, and set `script_ambiguous`.
 *
 *  2. **Romanised Indic is genuinely hard.** "bahut log ghayal hain" is Hindi
 *     written in Latin script. Function-word matching catches the common cases;
 *     it will not catch all of them, and it reports lower confidence
 *     accordingly.
 */

export interface Detection {
  language: SpokenLanguage;
  confidence: number;
  /** Unicode script observed, or "latin". */
  script: string;
  /** True when more than one script appears — code-switching, written down. */
  mixed: boolean;
  /** True when the script maps to several languages and we picked the likeliest. */
  script_ambiguous: boolean;
  /** Every language plausibly present, most likely first. */
  candidates: SpokenLanguage[];
}

/**
 * Unicode ranges for the scripts used by the scheduled languages.
 * Ordered so the more specific blocks are tested before shared ones.
 */
const SCRIPTS: Array<{
  name: string;
  re: RegExp;
  languages: SpokenLanguage[];
}> = [
  // Unambiguous: one script, one scheduled language.
  { name: "tamil", re: /[஀-௿]/, languages: ["ta"] },
  { name: "telugu", re: /[ఀ-౿]/, languages: ["te"] },
  { name: "kannada", re: /[ಀ-೿]/, languages: ["kn"] },
  { name: "malayalam", re: /[ഀ-ൿ]/, languages: ["ml"] },
  { name: "gujarati", re: /[઀-૿]/, languages: ["gu"] },
  { name: "odia", re: /[଀-୿]/, languages: ["or"] },
  { name: "gurmukhi", re: /[਀-੿]/, languages: ["pa"] },

  // Bengali script carries Bengali, Assamese and Manipuri.
  { name: "bengali", re: /[ঀ-৿]/, languages: ["bn", "as", "mni"] },

  // Perso-Arabic carries Urdu, Kashmiri and Sindhi.
  { name: "arabic", re: /[؀-ۿݐ-ݿ]/, languages: ["ur", "ks", "sd"] },

  // Ol Chiki is Santali's own script.
  { name: "ol_chiki", re: /[᱐-᱿]/, languages: ["sat"] },

  // Devanagari is the most shared block of all.
  {
    name: "devanagari",
    re: /[ऀ-ॿ]/,
    languages: ["hi", "mr", "mai", "ne", "kok", "doi", "brx", "sa"],
  },
];

/**
 * High-frequency Hindi/Urdu function words as written in Latin script.
 *
 * Function words rather than content words on purpose: they are short,
 * extremely common, and largely invariant across the dialect continuum, so they
 * discriminate far better than nouns. Several emergency-specific terms are
 * included because that is the register this system actually sees.
 */
const ROMANISED_HINDI = new Set([
  // copulas, pronouns, particles
  "hai", "hain", "haan", "nahi", "nahin", "kya", "kyun", "kyu", "koi", "kuch",
  "mera", "meri", "mere", "tera", "teri", "aap", "aapka", "tum", "hum", "hamara",
  "yeh", "ye", "woh", "wo", "iska", "uska", "mein", "main", "par", "aur", "ya",
  "se", "ko", "ka", "ki", "ke", "bhi", "toh", "to", "abhi", "jaldi", "bohot",
  "bahut", "thoda", "zyada", "kaise", "kahan", "kab", "kaun",
  // verbs common in distress calls
  "kar", "karo", "kare", "raha", "rahi", "rahe", "gaya", "gayi", "gaye",
  "hua", "hui", "huye", "hue", "aao", "aaiye", "bhejo", "bhej", "bulao",
  "chahiye", "dijiye", "do", "lag", "lagi", "laga", "gir", "gira", "giri",
  // emergency register
  "madad", "bachao", "accident", "haadsa", "aag", "khoon", "ghayal", "zakhmi",
  "ambulance", "police", "hospital", "mar", "mari", "behosh", "saans",
]);

/** Latin-script words that are unambiguously English, used as a counterweight. */
const ENGLISH_MARKERS = new Set([
  "the", "is", "are", "was", "were", "there", "here", "please", "help",
  "need", "someone", "people", "injured", "accident", "fire", "near",
  "hospital", "ambulance", "and", "have", "has", "been", "very", "quickly",
]);

function tokenise(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .filter(Boolean);
}

/**
 * Classifies Latin-script text as English, romanised Hindi, or a mix.
 *
 * Both counts are taken because a Hinglish sentence contains plenty of English:
 * "accident hua hai near ORR" is not English with stray words, and it is not
 * Hindi with stray words. It is mixed, and calling it either one loses
 * information the extractor can use.
 */
function classifyLatin(tokens: string[]): {
  language: SpokenLanguage;
  confidence: number;
  candidates: SpokenLanguage[];
} {
  if (tokens.length === 0) {
    return { language: "unknown", confidence: 0, candidates: [] };
  }

  // "accident", "police", "hospital" and "ambulance" appear in both lists —
  // they are loanwords in everyday Hindi and carry no signal either way.
  const hindiHits = tokens.filter(
    (t) => ROMANISED_HINDI.has(t) && !ENGLISH_MARKERS.has(t),
  ).length;
  const englishHits = tokens.filter(
    (t) => ENGLISH_MARKERS.has(t) && !ROMANISED_HINDI.has(t),
  ).length;

  const total = tokens.length;
  const hindiRatio = hindiHits / total;
  const englishRatio = englishHits / total;

  // Both registers clearly present: Hinglish.
  if (hindiHits >= 2 && englishHits >= 2) {
    return { language: "mixed", confidence: 0.8, candidates: ["hi", "en"] };
  }

  if (hindiRatio > englishRatio && hindiHits >= 2) {
    // Romanised Hindi is inherently a weaker call than native script; cap it.
    return {
      language: "hi",
      confidence: Math.min(0.55 + hindiRatio, 0.8),
      candidates: ["hi", "mixed"],
    };
  }

  if (englishHits >= 1 && englishRatio >= hindiRatio) {
    return {
      language: "en",
      confidence: Math.min(0.6 + englishRatio, 0.92),
      candidates: ["en"],
    };
  }

  // Latin script with nothing recognisable: a place name, a registration
  // number, a single word. English is the likeliest default but we say so
  // weakly rather than asserting it.
  return { language: "en", confidence: 0.35, candidates: ["en", "hi"] };
}

export function detectLanguage(text: string): Detection {
  const trimmed = text.trim();
  if (!trimmed) {
    return {
      language: "unknown",
      confidence: 0,
      script: "none",
      mixed: false,
      script_ambiguous: false,
      candidates: [],
    };
  }

  const present = SCRIPTS.filter((s) => s.re.test(trimmed));
  const hasLatin = /[A-Za-z]/.test(trimmed);
  const tokens = tokenise(trimmed);

  // No Indic script at all: a Latin-script judgement.
  if (present.length === 0) {
    const latin = classifyLatin(tokens);
    return {
      ...latin,
      script: hasLatin ? "latin" : "unknown",
      mixed: latin.language === "mixed",
      script_ambiguous: false,
    };
  }

  // More than one Indic script, or an Indic script alongside meaningful Latin
  // content, is code-switching written down.
  const latinWordCount = tokens.filter((t) => /^[a-z]+$/.test(t)).length;
  const mixed = present.length > 1 || latinWordCount >= 2;

  const primary = present[0]!;
  const ambiguous = primary.languages.length > 1;

  const candidates: SpokenLanguage[] = [
    ...new Set(present.flatMap((s) => s.languages)),
  ];

  if (mixed) {
    return {
      language: "mixed",
      confidence: 0.85,
      script: present.map((s) => s.name).join("+"),
      mixed: true,
      script_ambiguous: ambiguous,
      candidates,
    };
  }

  return {
    // For a shared block we name the most common language and flag the guess.
    language: primary.languages[0]!,
    // Native script is a strong signal; a shared block still limits certainty.
    confidence: ambiguous ? 0.7 : 0.95,
    script: primary.name,
    mixed: false,
    script_ambiguous: ambiguous,
    candidates: primary.languages,
  };
}
