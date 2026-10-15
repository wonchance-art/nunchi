// Synthetic fixture (nunchi guard mustache-text): near misses. A style object, an i18n <Trans> object child, code
// samples and CSS in <style> all have braces; none of them is a placeholder shown as text.
const template = 'Hello {{name}}';
export function Greeting({ name, t }: { name: string; t: (k: string, v: object) => string }) {
  return (
    <section style={{ color: 'inherit' }}>
      <Trans>Hello {{ name }}</Trans>
      <p>{t('greeting', { name })}</p>
      <code>{'{{name}}'}</code>
      <pre>{`{{#each ferns}}`}</pre>
      <style>{`@media (min-width: 40em) { .a { color: red }}`}</style>
      {/* {{ in a comment }} */}
      <p data-template="{{name}}">{template.length}</p>
    </section>
  );
}
