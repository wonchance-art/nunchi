// Scores a capture against a benchmark answer key (spec §8 release gates).
// Pure: answer key + manifest + findings in, report out.

export function score(answers, manifest, findings) {
  const scenes = new Map(manifest.scenes.map(s => [s.id, s]));
  const sceneOf = f => (f.scene ? scenes.get(f.scene) : null);
  const matches = (d, f) => {
    if (f.rule !== d.rule) return false;
    if (d.route && f.route !== d.route) return false;
    const s = sceneOf(f);
    if (d.person && (!s || s.person !== d.person)) return false;
    if (d.state && (!s || s.state !== d.state)) return false;
    if (d.viewport && f.viewport !== d.viewport) return false;
    if (d.evidence) for (const [k, v] of Object.entries(d.evidence)) if (f.evidence?.[k] !== v) return false;
    return true;
  };
  const ruled = answers.defects.filter(d => d.rule);
  const found = []; const missed = [];
  const used = new Set();
  for (const d of ruled) {
    const hits = findings.filter(f => matches(d, f));
    hits.forEach(h => used.add(h));
    (hits.length ? found : missed).push({ id: d.id, lens: d.lens, rule: d.rule, route: d.route, what: d.what, hits: hits.length });
  }
  const byLens = {};
  for (const d of ruled) {
    const l = (byLens[d.lens] ||= { seeded: 0, found: 0 });
    l.seeded++;
    if (found.some(x => x.id === d.id)) l.found++;
  }
  const clean = new Set(answers.clean || []);
  const cleanFindings = findings.filter(f => clean.has(f.route));
  const cleanScenes = manifest.scenes.filter(s => clean.has(s.route) && s.status === 'captured').length;
  const unexpected = findings.filter(f => !used.has(f) && !clean.has(f.route));
  const groups = {};
  for (const f of unexpected) { const k = `${f.rule} ${f.route ?? ''}`.trim(); groups[k] = (groups[k] || 0) + 1; }
  return {
    ruleRecall: { found: found.length, seeded: ruled.length, rate: ruled.length ? found.length / ruled.length : 1, byLens },
    missed,
    cleanFalsePositives: { findings: cleanFindings.length, scenes: cleanScenes, perScene: cleanScenes ? cleanFindings.length / cleanScenes : 0, list: cleanFindings.map(f => `${f.scene} ${f.rule} ${f.selector ?? ''}`) },
    notInAnswerKey: Object.entries(groups).sort().map(([k, n]) => ({ finding: k, count: n })),
    pendingLenses: answers.defects.filter(d => !d.rule).length,
  };
}

export function reportMarkdown(r, meta) {
  const pct = x => `${Math.round(x * 1000) / 10}%`;
  const lines = [
    `# nunchi benchmark — ${meta.app}`,
    '',
    `${meta.when} · ${meta.scenes} scenes · ${meta.seconds}s${meta.determinism ? ` · determinism: ${meta.determinism}` : ''}`,
    '',
    '## Gates (0.1-a)',
    '',
    '| Gate | Target | Result |',
    '|---|---|---|',
    `| Rule-lens recall | 100% | ${r.ruleRecall.found}/${r.ruleRecall.seeded} (${pct(r.ruleRecall.rate)}) |`,
    `| False positives on clean scenes | ≤ 0.1 per scene | ${r.cleanFalsePositives.findings} on ${r.cleanFalsePositives.scenes} scenes (${r.cleanFalsePositives.perScene.toFixed(2)}) |`,
    ...(meta.determinism ? [`| Determinism (2 runs, byte-identical evidence) | identical | ${meta.determinism} |`] : []),
    '',
    '## Recall by lens',
    '',
    '| Lens | Found / seeded |',
    '|---|---|',
    ...Object.entries(r.ruleRecall.byLens).sort((a, b) => Number(a[0].slice(1)) - Number(b[0].slice(1))).map(([l, v]) => `| ${l} | ${v.found}/${v.seeded} |`),
    '',
    `${r.pendingLenses} more seeded defects belong to AI lenses (0.1-b) and are not scored yet.`,
    '',
    '## Missed',
    '',
    ...(r.missed.length ? r.missed.map(m => `- ${m.id} ${m.lens} \`${m.rule}\` ${m.route ?? ''} — ${m.what}`) : ['- none']),
    '',
    '## False positives on clean scenes',
    '',
    ...(r.cleanFalsePositives.list.length ? r.cleanFalsePositives.list.map(x => `- ${x}`) : ['- none']),
    '',
    '## Findings not in the answer key (review: real extra defect or false positive?)',
    '',
    ...(r.notInAnswerKey.length ? r.notInAnswerKey.map(x => `- ${x.finding} ×${x.count}`) : ['- none']),
    '',
  ];
  return lines.join('\n');
}
