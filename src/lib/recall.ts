// Bounded query normalization and best-effort secret redaction.
const STOP = new Set(('the and for with this that from have please continue work 작업 진행 확인 계속 관련 ' +
  '해줘 할게 같은 이제 지금 먼저 다시 대한 어떻게 그리고 그러면 일단 이번 부탁 내용 필요 계속해 진행해 네 그래 응 좋아 좋아요 알겠어 오케이').split(' '));

export function redactMemory(text: string): string {
  return text
    .replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?(?:-----END [^-]*PRIVATE KEY-----|$)/g, '[REDACTED PRIVATE KEY]')
    .replace(/\b(?:sk-[a-zA-Z0-9_-]{12,}|gh[pousr]_[a-zA-Z0-9_]{12,}|github_pat_[a-zA-Z0-9_]+)\b/g, '[REDACTED TOKEN]')
    .replace(/(\b(?:api[_-]?key|access[_-]?token|refresh[_-]?token|password|secret|authorization)\b["']?\s*[:=]\s*)(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,;]+)/gi, '$1[REDACTED]')
    .replace(/\bBearer\s+[a-zA-Z0-9_.-]+/gi, 'Bearer [REDACTED]');
}

export function recallTerms(prompt: string): string[] {
  const terms = redactMemory(prompt).normalize('NFKC').toLowerCase().match(/[\p{L}\p{N}][\p{L}\p{N}_-]*/gu) || [];
  const result = terms.map(t => /^[가-힣]+$/.test(t) ? t.replace(/(?:해줘요|해줘|해주세요|해볼래|하자)$/, '').replace(/(?:에서는|에서|에게|으로|부터|까지|하고|이랑|에는|은|는|을|를|이|가|에|도|의)$/, '') : t)
    .filter(t => t.length >= 2 && !STOP.has(t) && !/^(?:\d+|[\u1100-\u11FF\u3130-\u318F\uA960-\uA97F\uD7B0-\uD7FF]+)$/.test(t) && t !== 'redacted');
  if (result.includes('소울')) result.push('soul');
  if (result.includes('soul')) result.push('소울');
  return [...new Set(result)].slice(0, 32);
}
