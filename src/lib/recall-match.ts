// Deterministic domain vocabulary, not a semantic model. Each alias group counts once.
export interface RecallQuery { groups: string[][] }
export interface RecallMatch { count: number; score: number; terms: string[]; eligible: boolean }
const ALIASES = [
  ['soul', '소울'], ['checkpoint', '체크포인트'], ['restore', '복원', '복구'],
  ['backup', '백업'], ['boot', '부팅'], ['session', '세션'], ['retry', '재시도'],
  ['correction', '교정'], ['evidence', '증거', '근거'], ['hook', '훅'],
];
const normalize = (value: string) => value.normalize('NFKC').toLowerCase();
const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
export function recallQuery(terms: string[]): RecallQuery {
  const groups = new Map<string, string[]>();
  for (const term of terms) {
    const group = ALIASES.find(values => values.includes(term)) || [term];
    groups.set(group[0] ?? term, group);
  }
  return { groups: [...groups.values()] };
}
function contains(text: string, term: string): boolean {
  if (/[가-힣]/.test(term)) return text.includes(term);
  // Korean particles may follow English identifiers; other word suffixes cannot.
  const suffix = '(?=$|[^\\p{L}\\p{N}_]|(?:에서는|에서|에게|으로|부터|까지|에는|은|는|을|를|이|가|에|도|의|와|과)(?=$|[^\\p{L}\\p{N}_]))';
  return new RegExp('(?:^|[^\\p{L}\\p{N}_])' + escape(term) + suffix, 'u').test(text);
}
export function matchRecall(value: string, query: RecallQuery): RecallMatch {
  const text = normalize(value), matched = query.groups.map(group => group.filter(term => contains(text, term))).filter(group => group.length);
  return { count: matched.length, score: query.groups.length ? matched.length / query.groups.length : 0,
    terms: matched.flat(), eligible: matched.length >= Math.min(2, Math.max(1, query.groups.length)) };
}
export function recallExcerpt(value: string, query: RecallQuery, maxChars = 420): string {
  const ranked = value.normalize('NFKC').split(/\n+|(?<=[.!?。])\s+/u).filter(Boolean)
    .map((text, index) => ({ text, index, match: matchRecall(text, query) }))
    .filter(piece => piece.match.count).sort((a, b) => b.match.score - a.match.score || a.index - b.index).slice(0, 3);
  return ranked.sort((a, b) => a.index - b.index).map(piece => {
    if (piece.text.length <= maxChars) return piece.text;
    const lower = normalize(piece.text), at = Math.min(...piece.match.terms.map(term => lower.indexOf(term)).filter(i => i >= 0));
    let start = Math.max(0, at - 80);
    if (start && /[\uDC00-\uDFFF]/.test(piece.text[start] || '')) start--;
    return (start ? '…' : '') + Array.from(piece.text.slice(start)).slice(0, maxChars).join('') + '…';
  }).join('\n');
}
export function markedCorrection(text: string): boolean {
  return /(?:사용자\s*교정|user\s+correction)(?=\s|[:：]|$)/i.test(text);
}
