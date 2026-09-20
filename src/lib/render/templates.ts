import { fontFaceCss, FONT_FAMILIES, SCRIPT_STYLE } from "./fonts";
import type { RenderRequest, SlideType } from "./types";
import { photoSlotFor, type BrandTokens, type TenantConfig } from "@/lib/tenants";

/**
 * Slide markup.
 *
 * Every typographic element on a slide is rendered here, deterministically,
 * from tenant brand tokens. Nothing on a slide comes out of an image model:
 * disclaimer text in particular has to be exact, diffable and versionable.
 */

export function escapeHtml(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function color(tokens: BrandTokens, name: string, fallback: string): string {
  return tokens?.color?.[name] ?? fallback;
}

interface Palette {
  navy: string;
  cream: string;
  sage: string;
  sageTint: string;
  gold: string;
  goldText: string;
  goldLight: string;
  slate: string;
  rule: string;
  cardBorder: string;
  navySub: string;
  navyFooter: string;
  navyRule: string;
}

interface SlideContext {
  copy: Record<string, unknown>;
  photoUrl?: string | null;
  tenant: TenantConfig;
  p: Palette;
  /** The template the slide belongs to — it decides photo slots and labels. */
  template?: string;
}

function palette(tokens: BrandTokens): Palette {
  return {
    navy: color(tokens, "navy", "#17395C"),
    cream: color(tokens, "cream", "#F7F4ED"),
    sage: color(tokens, "sage", "#56653C"),
    sageTint: color(tokens, "sage_tint", "#E4E7DA"),
    gold: color(tokens, "gold", "#A08A4B"),
    goldText: color(tokens, "gold_text", "#7A6534"),
    goldLight: color(tokens, "gold_light", "#C9A961"),
    slate: color(tokens, "slate", "#5A6B7D"),
    rule: color(tokens, "rule", "#DED8C8"),
    cardBorder: color(tokens, "card_border", "#E3DDCC"),
    navySub: color(tokens, "navy_sub", "#C8D2DC"),
    navyFooter: color(tokens, "navy_footer", "#A8BACA"),
    navyRule: color(tokens, "navy_rule", "#2E5175"),
  };
}

/** A brand colour at an alpha, for scrims over photography. */
function rgba(hex: string, alpha: number): string {
  const match = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!match) return `rgba(0,0,0,${alpha})`;
  const int = parseInt(match[1], 16);
  return `rgba(${(int >> 16) & 255},${(int >> 8) & 255},${int & 255},${alpha})`;
}

/**
 * A slide's fixed label — the word the template puts on the slide rather than
 * anything the copy model writes. Tenant config can override it per slide.
 */
function slideLabel(
  tenant: TenantConfig,
  template: string | undefined,
  type: string,
  fallback: string,
): string {
  const label = template
    ? tenant.templates?.[template]?.slide_specs?.[type]?.label
    : undefined;
  return label ?? fallback;
}

/**
 * The photo, or the field it will land in. On a full-bleed slot the
 * placeholder label sits high, clear of the copy the scrim sits under.
 */
function photoBlock(
  photoUrl: string | null | undefined,
  p: Palette,
  align: "center" | "top" = "center",
): string {
  if (photoUrl) {
    return `<img src="${escapeHtml(photoUrl)}" alt="" style="width:100%;height:100%;object-fit:cover;display:block;">`;
  }
  const placement =
    align === "top" ? "align-items:flex-start;padding-top:150px;" : "align-items:center;";
  return `<div style="width:100%;height:100%;display:flex;${placement}justify-content:center;box-sizing:border-box;background:${p.sageTint};">
         <div style="font-family:${FONT_FAMILIES.body};font-size:19px;letter-spacing:2px;text-transform:uppercase;color:${p.sage};">Photo pending</div>
       </div>`;
}

/**
 * Copy set as reported speech. The model is told to write the myth as a
 * sentence and not to punctuate it as a quotation, but a sentence that arrives
 * already quoted must not come out double-quoted, so whatever it arrives in is
 * replaced with the one pair the slide sets.
 */
function quoted(value: unknown): string {
  const text = String(value ?? "").trim().replace(/^["“”‘’']+|["“”‘’']+$/g, "").trim();
  return text ? `“${text}”` : "";
}

function kickerBlock(text: string, p: Palette, onNavy = false): string {
  const fg = onNavy ? p.goldLight : p.sage;
  const rule = onNavy ? p.goldLight : p.gold;
  return `<div class="kicker">
  <div style="font-size:17px;font-weight:500;letter-spacing:3.8px;text-transform:uppercase;color:${fg};">${escapeHtml(text)}</div>
  <div style="width:70px;height:2px;background:${rule};margin-top:18px;"></div>
</div>`;
}

function footerBlock(tenant: TenantConfig, p: Palette, onNavy = false): string {
  const left = tenant.footer?.left ?? tenant.website ?? "";
  const right = onNavy
    ? (tenant.footer?.contact ?? "")
    : (tenant.footer?.right ?? "");
  const fg = onNavy ? p.navyFooter : p.sage;
  const line = onNavy ? p.navyRule : p.rule;
  return `<div class="footer">
  <div style="height:1px;background:${line};"></div>
  <div style="margin-top:22px;display:flex;justify-content:space-between;align-items:center;gap:24px;">
    <span style="font-size:15px;font-weight:500;letter-spacing:1.9px;text-transform:uppercase;color:${fg};">${escapeHtml(left)}</span>
    <span style="font-size:15px;font-weight:400;letter-spacing:1.9px;text-transform:uppercase;color:${fg};text-align:right;">${escapeHtml(right)}</span>
  </div>
</div>`;
}

function hookSlide({ copy, photoUrl, tenant, p, template }: SlideContext): string {
  const slot = photoSlotFor(template ? tenant.templates?.[template] : undefined, "hook");
  const photo = photoBlock(photoUrl, p);
  return `<div class="slide" style="background:${p.cream};display:flex;flex-direction:column;">
  <div style="width:${slot.w}px;height:${slot.h}px;overflow:hidden;background:${p.sageTint};flex:0 0 auto;">${photo}</div>
  <div style="flex:1 1 auto;min-height:0;box-sizing:border-box;padding:60px 76px 58px;display:flex;flex-direction:column;justify-content:space-between;gap:24px;">
    <div class="grow" style="display:flex;flex-direction:column;justify-content:center;gap:30px;min-height:0;">
      ${kickerBlock(String(copy.kicker ?? ""), p)}
      <h1 data-fit="86,46" style="margin:0;font-family:${FONT_FAMILIES.display};font-weight:600;font-size:86px;line-height:1.03;letter-spacing:-0.5px;color:${p.navy};">${escapeHtml(copy.headline)}</h1>
      <p data-fit="48,28" style="margin:0;font-family:${FONT_FAMILIES.script};${SCRIPT_STYLE}font-size:48px;line-height:1.3;color:${p.goldText};">${escapeHtml(copy.script_line)}</p>
    </div>
    <div style="display:flex;align-items:center;gap:14px;">
      <span style="font-size:16px;font-weight:500;letter-spacing:3px;text-transform:uppercase;color:${p.sage};">Swipe</span>
      <svg width="40" height="10" viewBox="0 0 40 10" fill="none"><path d="M0 5h36M32 1l5 4-5 4" stroke="${p.sage}" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>
    </div>
  </div>
</div>`;
}

function causeSlide({ copy, tenant, p }: SlideContext): string {
  const items = Array.isArray(copy.items)
    ? (copy.items as { label: string; text: string }[])
    : [];
  const cells = items
    .map(
      (item) => `<div style="display:flex;gap:16px;break-inside:avoid;">
      <div style="width:9px;height:9px;border-radius:50%;background:${p.gold};margin-top:13px;flex:0 0 auto;"></div>
      <div>
        <div style="font-size:27px;font-weight:500;line-height:1.22;color:${p.navy};">${escapeHtml(item.label)}</div>
        <div style="margin-top:10px;font-size:20.5px;font-weight:400;line-height:1.5;color:${p.slate};">${escapeHtml(item.text)}</div>
      </div>
    </div>`,
    )
    .join("\n");
  return `<div class="slide" style="background:${p.cream};box-sizing:border-box;padding:78px 76px 62px;display:flex;flex-direction:column;justify-content:space-between;gap:36px;">
  ${kickerBlock(String(copy.kicker ?? ""), p)}
  <div class="grow" style="display:flex;flex-direction:column;justify-content:center;gap:44px;min-height:0;">
    <div>
      <h1 data-fit="70,40" style="margin:0;font-family:${FONT_FAMILIES.display};font-weight:600;font-size:70px;line-height:1.07;letter-spacing:-0.4px;color:${p.navy};">${escapeHtml(copy.headline)}</h1>
      <p data-fit="24,17" style="margin:18px 0 0;font-size:24px;font-weight:400;line-height:1.5;color:${p.slate};max-width:880px;">${escapeHtml(copy.sub)}</p>
    </div>
    <div data-fit-scale="items" style="display:grid;grid-template-columns:repeat(2,minmax(0,1fr));column-gap:50px;row-gap:46px;">
${cells}
    </div>
  </div>
  ${footerBlock(tenant, p)}
</div>`;
}

function protocolSlide({ copy, tenant, p }: SlideContext): string {
  const cards = Array.isArray(copy.cards)
    ? (copy.cards as { title: string; text: string }[])
    : [];
  const grid = cards
    .map(
      (card) => `<div style="background:#FFFFFF;border:1px solid ${p.cardBorder};border-radius:4px;padding:38px 34px;display:flex;flex-direction:column;gap:13px;">
      <div style="font-family:${FONT_FAMILIES.display};font-weight:600;font-size:35px;line-height:1.1;color:${p.navy};">${escapeHtml(card.title)}</div>
      <div style="font-size:19.5px;font-weight:400;line-height:1.5;color:${p.slate};">${escapeHtml(card.text)}</div>
    </div>`,
    )
    .join("\n");
  const disclaimer = String(copy.disclaimer ?? "");
  return `<div class="slide" style="background:${p.cream};box-sizing:border-box;padding:78px 76px 62px;display:flex;flex-direction:column;justify-content:space-between;gap:32px;">
  ${kickerBlock(String(copy.kicker ?? ""), p)}
  <div class="grow" style="display:flex;flex-direction:column;justify-content:center;gap:34px;min-height:0;">
    <h1 data-fit="70,40" style="margin:0;font-family:${FONT_FAMILIES.display};font-weight:600;font-size:70px;line-height:1.07;letter-spacing:-0.4px;color:${p.navy};">${escapeHtml(copy.headline)}</h1>
    <div style="display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:30px;">
${grid}
    </div>
    ${disclaimer ? `<p data-fit="16,11" style="margin:0;font-size:16px;font-weight:400;line-height:1.5;color:${p.slate};">${escapeHtml(disclaimer)}</p>` : ""}
  </div>
  ${footerBlock(tenant, p)}
</div>`;
}

function ctaSlide({ copy, tenant, p }: SlideContext): string {
  const points = Array.isArray(copy.trust_points)
    ? (copy.trust_points as string[])
    : [];
  const list = points
    .map(
      (point) => `<div style="display:flex;align-items:flex-start;gap:15px;">
      <svg width="22" height="22" viewBox="0 0 18 18" fill="none" style="margin-top:4px;flex:0 0 auto;"><path d="M3 9.5l4 4L15 5" stroke="${p.goldLight}" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>
      <span style="font-size:22px;font-weight:400;line-height:1.45;color:${p.navySub};">${escapeHtml(point)}</span>
    </div>`,
    )
    .join("\n");
  return `<div class="slide" style="background:${p.navy};box-sizing:border-box;padding:86px 80px 70px;display:flex;flex-direction:column;justify-content:space-between;gap:34px;">
  ${kickerBlock(String(copy.kicker ?? ""), p, true)}
  <div class="grow" style="display:flex;flex-direction:column;justify-content:center;gap:28px;min-height:0;">
    <h1 data-fit="86,46" style="margin:0;font-family:${FONT_FAMILIES.display};font-weight:600;font-size:86px;line-height:1.04;letter-spacing:-0.6px;color:${p.cream};">${escapeHtml(copy.headline)}</h1>
    <p data-fit="25,17" style="margin:0;font-size:25px;font-weight:400;line-height:1.5;color:${p.navySub};max-width:880px;">${escapeHtml(copy.body)}</p>
    <div style="display:flex;flex-direction:column;gap:19px;margin-top:6px;">
${list}
    </div>
    <div style="align-self:flex-start;margin-top:16px;background:${p.goldLight};color:${p.navy};padding:25px 54px;border-radius:2px;font-size:19px;font-weight:500;letter-spacing:2.6px;text-transform:uppercase;">Book a Consult</div>
  </div>
  ${footerBlock(tenant, p, true)}
</div>`;
}

/**
 * Slide 1 of a myth buster: the line the reader has already been told, set as
 * large as it will go on a field of its own — no photo, no body copy, nothing
 * competing with it. That is the whole distinction from a symptom carousel's
 * hook.
 *
 * It is also the slide most likely to be read on its own, so the statement is
 * marked false before it is read: the label is a filled badge rather than a
 * corner kicker, and the myth is quoted, as something patients are told. A
 * scroller must not be able to take the line as the practice's position.
 */
function mythSlide({ copy, tenant, p, template }: SlideContext): string {
  const label = slideLabel(tenant, template, "myth", "Myth");
  const kicker = String(copy.kicker ?? "");
  return `<div class="slide" style="background:${p.sageTint};box-sizing:border-box;padding:84px 84px 74px;display:flex;flex-direction:column;gap:46px;">
  <div class="kicker" style="display:flex;align-items:center;justify-content:space-between;gap:28px;">
    <span style="background:${p.navy};color:${p.cream};padding:19px 34px 21px;border-radius:2px;font-size:31px;font-weight:600;line-height:1;letter-spacing:7px;text-transform:uppercase;">${escapeHtml(label)}</span>
    ${kicker ? `<span style="font-size:17px;font-weight:400;letter-spacing:2.8px;text-transform:uppercase;color:${p.sage};">${escapeHtml(kicker)}</span>` : ""}
  </div>
  <div class="grow" style="display:flex;flex-direction:column;justify-content:center;min-height:0;">
    <h1 data-fit="190,80" style="margin:0;font-family:${FONT_FAMILIES.display};font-weight:600;font-size:190px;line-height:1.02;letter-spacing:-1.4px;color:${p.navy};text-indent:-0.35em;">${escapeHtml(quoted(copy.headline))}</h1>
  </div>
  <div style="display:flex;align-items:center;gap:14px;">
    <span style="font-size:16px;font-weight:500;letter-spacing:3px;text-transform:uppercase;color:${p.sage};">Swipe</span>
    <svg width="40" height="10" viewBox="0 0 40 10" fill="none"><path d="M0 5h36M32 1l5 4-5 4" stroke="${p.sage}" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>
  </div>
</div>`;
}

/**
 * Slide 2: the correction, with room to explain why. Still type-led, and sized
 * to fill the frame rather than float in the middle of it — this is the slide
 * that has to be readable at feed size.
 */
function correctionSlide({ copy, tenant, p, template }: SlideContext): string {
  const label = slideLabel(tenant, template, "correction", "What is actually going on");
  const disclaimer = String(copy.disclaimer ?? "");
  return `<div class="slide" style="background:${p.cream};box-sizing:border-box;padding:84px 84px 62px;display:flex;flex-direction:column;gap:40px;">
  ${kickerBlock(label, p)}
  <div class="grow" style="display:flex;flex-direction:column;justify-content:center;gap:40px;min-height:0;">
    <h1 data-fit="118,58" style="margin:0;font-family:${FONT_FAMILIES.display};font-weight:600;font-size:118px;line-height:1.05;letter-spacing:-0.9px;color:${p.navy};">${escapeHtml(copy.headline)}</h1>
    <p data-fit="40,25" style="margin:0;font-size:40px;font-weight:400;line-height:1.45;color:${p.slate};">${escapeHtml(copy.body)}</p>
    ${disclaimer ? `<p data-fit="17,12" style="margin:0;font-size:17px;font-weight:400;line-height:1.5;color:${p.slate};">${escapeHtml(disclaimer)}</p>` : ""}
  </div>
  ${footerBlock(tenant, p)}
</div>`;
}

/**
 * The whole of a single card: one statement over a full-bleed photo. The scrim
 * is what makes the type readable regardless of what the image model returns,
 * so it is drawn from the navy token rather than left to the photograph.
 */
function statementSlide({ copy, photoUrl, tenant, p }: SlideContext): string {
  const attribution = String(copy.attribution ?? "");
  const disclaimer = String(copy.disclaimer ?? "");
  const kicker = String(copy.kicker ?? "");
  const scrim = `linear-gradient(180deg, ${rgba(p.navy, 0.18)} 0%, ${rgba(p.navy, 0.62)} 44%, ${rgba(p.navy, 0.92)} 100%)`;
  // Every word sits in the bottom of the scrim, where the navy is close to
  // solid. A label floating over the top of the photograph is legible right
  // up until the image model returns a bright sky.
  return `<div class="slide" style="background:${p.navy};position:relative;">
  <div style="position:absolute;inset:0;">${photoBlock(photoUrl, p, "top")}</div>
  <div style="position:absolute;inset:0;background:${scrim};"></div>
  <div style="position:relative;height:100%;box-sizing:border-box;padding:86px 80px 70px;display:flex;flex-direction:column;justify-content:flex-end;gap:44px;">
    <div class="grow" style="flex:1 1 auto;display:flex;flex-direction:column;justify-content:flex-end;gap:26px;min-height:0;">
      ${kicker ? kickerBlock(kicker, p, true) : ""}
      <p data-fit="86,44" style="margin:0;font-family:${FONT_FAMILIES.display};font-weight:600;font-size:86px;line-height:1.07;letter-spacing:-0.5px;color:${p.cream};">${escapeHtml(copy.statement)}</p>
      ${attribution ? `<div style="font-size:19px;font-weight:500;letter-spacing:2.6px;text-transform:uppercase;color:${p.navySub};">${escapeHtml(attribution)}</div>` : ""}
      ${disclaimer ? `<p data-fit="16,11" style="margin:0;font-size:16px;font-weight:400;line-height:1.5;color:${p.navySub};">${escapeHtml(disclaimer)}</p>` : ""}
    </div>
    ${footerBlock(tenant, p, true)}
  </div>
</div>`;
}

const RENDERERS: Record<SlideType, (context: SlideContext) => string> = {
  hook: hookSlide,
  cause: causeSlide,
  protocol: protocolSlide,
  cta: ctaSlide,
  myth: mythSlide,
  correction: correctionSlide,
  statement: statementSlide,
};

/**
 * Shrink-to-fit. Generated copy varies in length; a headline that overflows
 * its box is the difference between a slide that ships and one that has to be
 * regenerated. Elements carry data-fit="max,min" in px, and the largest size
 * that still fits wins — which is also what keeps a short headline filling the
 * frame instead of floating in the middle of it.
 */
const FIT_SCRIPT = `
(function () {
  /**
   * Layout overflow, not ink overflow.
   *
   * Display type here is set tighter than its own line box (line-height 1.02),
   * so a headline always reports a scrollHeight a few px past its clientHeight
   * — its own descenders. Measuring that would call every size a failure and
   * push every headline to its minimum. What matters is whether a child has
   * escaped the column it has to sit in.
   */
  function overflows(box) {
    var rect = box.getBoundingClientRect();
    for (var i = 0; i < box.children.length; i++) {
      var child = box.children[i].getBoundingClientRect();
      if (child.top < rect.top - 1 || child.bottom > rect.bottom + 1) return true;
    }
    return false;
  }

  function fit() {
    document.querySelectorAll('[data-fit]').forEach(function (el) {
      var spec = el.getAttribute('data-fit').split(',');
      var max = parseFloat(spec[0]);
      var min = parseFloat(spec[1]);
      var box = el.closest('.grow') || el.parentElement;
      // While fitting, a word wider than its line is an overflow rather than
      // something to break: display sizes are large enough that "testosterone"
      // can outgrow the column, and a size that snaps a clinical word in half
      // is not a size that fits. The stylesheet's break-word comes back
      // afterwards, so copy that cannot fit at any size still wraps instead of
      // being clipped.
      el.style.overflowWrap = 'normal';
      for (var size = max; size >= min; size -= 1) {
        el.style.fontSize = size + 'px';
        if (!overflows(box) && el.scrollWidth <= el.clientWidth + 1) {
          el.style.overflowWrap = '';
          return;
        }
      }
      el.style.overflowWrap = '';
      el.style.fontSize = min + 'px';
    });
    // Last resort: if the growing column still overflows, tighten leading.
    document.querySelectorAll('.grow').forEach(function (box) {
      var tries = 0;
      while (overflows(box) && tries < 8) {
        box.style.gap = Math.max(8, (parseFloat(getComputedStyle(box).gap) || 24) - 4) + 'px';
        tries++;
      }
    });
  }

  // Fit in the face the slide is actually set in. The fonts are embedded, but
  // they still arrive after first layout, and a size measured against the
  // fallback serif is a size chosen for a font that is not on the slide. The
  // race is a floor, not a preference: a font that never resolves must not
  // leave the slide unfitted forever.
  var ready = document.fonts && document.fonts.ready
    ? Promise.race([
        document.fonts.ready,
        new Promise(function (resolve) { setTimeout(resolve, 5000); }),
      ])
    : Promise.resolve();

  ready.then(function () {
    fit();
    document.documentElement.setAttribute('data-fitted', 'true');
  });
})();
`;

export async function slideHtml(request: RenderRequest): Promise<string> {
  const { tenant, slide } = request;
  const p = palette(tenant.brand_tokens);
  const width = tenant.output?.width ?? 1080;
  const height = tenant.output?.height ?? 1350;
  const render = RENDERERS[slide.type] ?? RENDERERS.hook;
  const body = render({
    copy: slide.copy,
    photoUrl: slide.photoUrl,
    tenant,
    p,
    template: slide.template,
  });
  const fonts = await fontFaceCss();

  return `<!doctype html>
<html lang="${escapeHtml(tenant.locale ?? "en-US")}">
<head>
<meta charset="utf-8">
<title>${escapeHtml(tenant.name)} — slide ${slide.position}</title>
<style>
${fonts}
*{box-sizing:border-box;}
html,body{margin:0;padding:0;background:${p.cream};}
body{font-family:${FONT_FAMILIES.body};-webkit-font-smoothing:antialiased;text-rendering:geometricPrecision;}
.slide{width:${width}px;height:${height}px;overflow:hidden;position:relative;}
.kicker,.footer{flex:0 0 auto;}
.grow{flex:1 1 auto;min-height:0;}
h1,p{overflow-wrap:break-word;hyphens:none;}
</style>
</head>
<body>
${body}
<script>${FIT_SCRIPT}</script>
</body>
</html>`;
}
