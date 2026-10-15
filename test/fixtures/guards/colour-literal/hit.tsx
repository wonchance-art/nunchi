// Synthetic fixture (nunchi guard colour-literal; tokens #1f2937, #ffffff, rgb(37, 99, 235)): every line marked HIT
// holds a colour literal outside the tokens.
export function FernCard({ ok }: { ok: boolean }) {
  return (
    <div
      style={{
        color: '#ff0000', /* HIT colour-literal */
        borderColor: 'tomato', /* HIT colour-literal */
        background: 'linear-gradient(#123456, #ffffff)', /* HIT colour-literal */
        boxShadow: '0 1px 2px rgb(0 0 0 / 0.5)', /* HIT colour-literal */
        outlineColor: ok ? 'transparent' : '#00aa00', /* HIT colour-literal */
        padding: 8,
      }}
      className="p-2 bg-[#abcdef]" /* HIT colour-literal */
    >
      <svg><path fill="#00ff00" /></svg>{/* HIT colour-literal */}
      <p className="shadow-[0_0_0_1px_#aa0000]">x</p>{/* HIT colour-literal */}
      <p className="hover:[color:#0000aa]">x</p>{/* HIT colour-literal */}
      <font color="red">x</font>{/* HIT colour-literal */}
    </div>
  );
}
